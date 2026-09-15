/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars */
/**
 * SmartEco AI Admin Portal — enforcement layer.
 * Drop into: src/authz/policy.ts
 * Deps: @casl/ability @casl/prisma @nestjs/core
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
} from '@casl/ability';
import {
  Action,
  BASE_GRANTS,
  Grant,
  ROLE_POLICIES,
  RoleKey,
  Subject,
} from './permissions';

export type AppAbility = MongoAbility<[Action, Subject | 'all']>;

export interface StaffPrincipal {
  userId: string;
  orgId: string;
  roles: RoleKey[];
  mfaVerifiedAt?: string; // ISO; step-up must be inside the freshness window
  assignedCustomerIds?: string[];
}

const MFA_FRESHNESS_MS = 15 * 60 * 1000;

/** Replace `${...}` placeholders in condition values with principal data. */
function interpolate(value: unknown, p: StaffPrincipal): unknown {
  if (typeof value === 'string' && value.startsWith('${')) {
    const key = value.slice(2, -1) as keyof StaffPrincipal;
    return p[key];
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, p));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, p)]),
    );
  }
  return value;
}

@Injectable()
export class AbilityFactory {
  forPrincipal(p: StaffPrincipal): AppAbility {
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(
      createMongoAbility,
    );

    const apply = (g: Grant) => {
      const fn = g.inverted ? cannot : can;
      const conditions = g.conditions
        ? (interpolate(g.conditions, p) as Record<string, unknown>)
        : undefined;
      fn(
        g.action as never,
        g.subject as never,
        g.fields as never,
        conditions as never,
      );
      if (g.reason && g.inverted) {
        // CASL keeps the message on the rule for a useful 403 body.
        (cannot as never as { reason?: string }).reason = g.reason;
      }
    };

    // Allows first, then role grants, then base denies so deny wins.
    for (const role of p.roles || []) {
      if (ROLE_POLICIES[role]) {
        ROLE_POLICIES[role].forEach(apply);
      }
    }
    BASE_GRANTS.forEach(apply);

    return build({
      detectSubjectType: (o) => (o as { __type: Subject }).__type,
    });
  }

  /** Union of maskFields across the principal's roles for a given subject. */
  maskedFieldsFor(p: StaffPrincipal, subject: Subject): string[] {
    const masked = new Set<string>();
    for (const role of p.roles || []) {
      if (ROLE_POLICIES[role]) {
        for (const g of ROLE_POLICIES[role]) {
          const subs = Array.isArray(g.subject) ? g.subject : [g.subject];
          if (subs.includes(subject))
            g.maskFields?.forEach((f) => masked.add(f));
        }
      }
    }
    return [...masked];
  }

  /** Strictest cap wins if a user somehow holds two roles. */
  limitsFor(p: StaffPrincipal, subject: Subject, action: Action) {
    let maxAmountRwf = Infinity;
    let maxPointsPerDay = Infinity;
    for (const role of p.roles || []) {
      if (ROLE_POLICIES[role]) {
        for (const g of ROLE_POLICIES[role]) {
          const subs = Array.isArray(g.subject) ? g.subject : [g.subject];
          const acts = Array.isArray(g.action) ? g.action : [g.action];
          if (!subs.includes(subject) || !acts.includes(action) || g.inverted)
            continue;
          if (g.limits?.maxAmountRwf != null)
            maxAmountRwf = Math.min(maxAmountRwf, g.limits.maxAmountRwf);
          if (g.limits?.maxPointsPerDay != null)
            maxPointsPerDay = Math.min(
              maxPointsPerDay,
              g.limits.maxPointsPerDay,
            );
        }
      }
    }
    return { maxAmountRwf, maxPointsPerDay };
  }

  requirementsFor(p: StaffPrincipal, subject: Subject, action: Action) {
    const req = new Set<string>();
    for (const role of p.roles || []) {
      if (ROLE_POLICIES[role]) {
        for (const g of ROLE_POLICIES[role]) {
          const subs = Array.isArray(g.subject) ? g.subject : [g.subject];
          const acts = Array.isArray(g.action) ? g.action : [g.action];
          if (!subs.includes(subject) || !acts.includes(action) || g.inverted)
            continue;
          g.requires?.forEach((r) => req.add(r));
        }
      }
    }
    return [...req];
  }
}

/* ---------------------------------------------------------------- */
/* Route decorator + guard                                           */
/* ---------------------------------------------------------------- */

export const PERMISSION_KEY = 'smarteco:permission';
export const RequirePermission = (action: Action, subject: Subject) =>
  SetMetadata(PERMISSION_KEY, { action, subject });

@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilities: AbilityFactory,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<{
      action: Action;
      subject: Subject;
    }>(PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!meta) return true;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated.');

    // Super admin bypasses fine-grained restrictions
    if (
      user.role === 'ADMIN' &&
      (!user.subRole ||
        user.subRole === 'Super Admin' ||
        user.subRole === 'SUPER_ADMIN')
    ) {
      req.policy = {
        requirements: [],
        limits: { maxAmountRwf: Infinity, maxPointsPerDay: Infinity },
        maskedFields: [],
      };
      return true;
    }

    const principal: StaffPrincipal = {
      userId: user.userId || user.id,
      orgId: user.orgId || 'org-kigali-01',
      roles:
        user.roles ||
        (user.subRole ? [user.subRole as RoleKey] : ['OPERATIONS_MANAGER']),
      mfaVerifiedAt: user.mfaVerifiedAt,
      assignedCustomerIds: user.assignedCustomerIds || [],
    };

    const ability = this.abilities.forPrincipal(principal);
    if (!ability.can(meta.action, meta.subject)) {
      throw new ForbiddenException(
        ability.relevantRuleFor(meta.action, meta.subject)?.reason ??
          `Your role does not allow ${meta.action} on ${meta.subject}.`,
      );
    }

    const requirements = this.abilities.requirementsFor(
      principal,
      meta.subject,
      meta.action,
    );

    if (requirements.includes('mfa')) {
      const fresh =
        principal.mfaVerifiedAt &&
        Date.now() - Date.parse(principal.mfaVerifiedAt) < MFA_FRESHNESS_MS;
      if (!fresh) throw new ForbiddenException('STEP_UP_REQUIRED');
    }

    if (requirements.includes('reason') && !req.body?.reason?.trim()) {
      throw new ForbiddenException(
        'A written reason is required for this action.',
      );
    }

    req.policy = {
      requirements,
      limits: this.abilities.limitsFor(principal, meta.subject, meta.action),
      maskedFields: this.abilities.maskedFieldsFor(principal, meta.subject),
      ability,
    };
    return true;
  }
}
