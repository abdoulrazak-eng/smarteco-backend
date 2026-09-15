/**
 * SmartEco AI Admin Portal — permission catalog and role policies.
 * Drop into: src/authz/permissions.ts (smarteco-backend, NestJS 11 + Prisma)
 *
 * Model: RBAC for the coarse grant + ABAC conditions for scope, amount caps,
 * field masking and step-up requirements. Deny always wins over allow.
 */

export const Action = {
  Read: 'read',
  Create: 'create',
  Update: 'update',
  Delete: 'delete',
  Approve: 'approve',
  Export: 'export',
  Execute: 'execute', // device commands, firmware pushes, reprocessing jobs
} as const;
export type Action = (typeof Action)[keyof typeof Action];

export const Subject = {
  // Customer / demand side
  Customer: 'Customer',
  CollectionRequest: 'CollectionRequest',
  // Operations
  Route: 'Route',
  Schedule: 'Schedule',
  Vehicle: 'Vehicle',
  Driver: 'Driver',
  TrackingSession: 'TrackingSession',
  // Assets & IoT
  Bin: 'Bin',
  Gateway: 'Gateway',
  Sensor: 'Sensor',
  Telemetry: 'Telemetry',
  AlertRule: 'AlertRule',
  DeviceCommand: 'DeviceCommand',
  Kiosk: 'Kiosk',
  ModelVersion: 'ModelVersion',
  // Money
  Payment: 'Payment',
  Invoice: 'Invoice',
  Subscription: 'Subscription',
  Refund: 'Refund',
  Tariff: 'Tariff',
  Payout: 'Payout',
  Reconciliation: 'Reconciliation',
  // Loyalty
  EcoPointsLedger: 'EcoPointsLedger',
  EcoPointsAdjustment: 'EcoPointsAdjustment',
  Reward: 'Reward',
  // Support
  Ticket: 'Ticket',
  Conversation: 'Conversation', // USSD / WhatsApp transcripts
  Broadcast: 'Broadcast',
  // Platform
  Report: 'Report',
  AdminUser: 'AdminUser',
  Role: 'Role',
  ApiKey: 'ApiKey',
  Integration: 'Integration',
  AuditLog: 'AuditLog',
} as const;
export type Subject = (typeof Subject)[keyof typeof Subject];

export type RoleKey =
  | 'OPERATIONS_MANAGER'
  | 'FINANCE_ADMIN'
  | 'IOT_SUPERVISOR'
  | 'SUPPORT_AGENT';

export interface Grant {
  action: Action | Action[];
  subject: Subject | Subject[];
  /** Field allow-list. Omit for all fields. */
  fields?: string[];
  /** Fields returned redacted even when the row is readable. */
  maskFields?: string[];
  /** CASL conditions; `${orgId}` / `${userId}` interpolated from the JWT. */
  conditions?: Record<string, unknown>;
  /** Step-up / workflow requirements enforced by PolicyGuard + ApprovalService. */
  requires?: Array<'mfa' | 'approval' | 'reason'>;
  /** Hard ceilings checked in the service layer before the write commits. */
  limits?: { maxAmountRwf?: number; maxPointsPerDay?: number };
  /** true => explicit deny (`cannot`), evaluated after all allows. */
  inverted?: boolean;
  reason?: string;
}

const A = Action;
const S = Subject;

/** Applies to every authenticated staff user. */
export const BASE_GRANTS: Grant[] = [
  { action: A.Read, subject: S.AdminUser, conditions: { id: '${userId}' } },
  {
    action: A.Update,
    subject: S.AdminUser,
    conditions: { id: '${userId}' },
    fields: ['name', 'phone', 'locale', 'avatarUrl'],
  },
  // Hard tenant boundary — nobody reads across organizations.
  {
    action: A.Read,
    subject: S.Customer,
    conditions: { orgId: { not: '${orgId}' } },
    inverted: true,
    reason: 'Cross-tenant access is not permitted.',
  },
  // Nobody self-administers roles from inside the portal.
  {
    action: [A.Create, A.Update, A.Delete],
    subject: [S.AdminUser, S.Role],
    inverted: true,
    reason: 'User and role administration is restricted to Platform Admin.',
  },
  // Destructive deletes are disabled portal-wide; use archive/void instead.
  {
    action: A.Delete,
    subject: [S.Payment, S.Invoice, S.Telemetry, S.AuditLog, S.EcoPointsLedger],
    inverted: true,
    reason: 'Financial, telemetry and audit records are append-only.',
  },
];

export const ROLE_POLICIES: Record<RoleKey, Grant[]> = {
  /* ------------------------------------------------------------------ */
  OPERATIONS_MANAGER: [
    // Owns day-to-day collection delivery inside their organization.
    {
      action: [A.Read, A.Create, A.Update],
      subject: S.Customer,
      conditions: { orgId: '${orgId}' },
      maskFields: ['nationalId', 'momoAccount'],
    },
    {
      action: [A.Read, A.Create, A.Update, A.Delete],
      subject: [S.CollectionRequest, S.Route, S.Schedule],
      conditions: { orgId: '${orgId}' },
    },
    {
      action: [A.Read, A.Create, A.Update],
      subject: [S.Vehicle, S.Driver],
      conditions: { orgId: '${orgId}' },
    },
    {
      action: A.Read,
      subject: S.TrackingSession,
      conditions: { orgId: '${orgId}' },
    },
    // Bins are an operational asset; provisioning/pairing stays with IoT.
    {
      action: [A.Read, A.Create, A.Update],
      subject: S.Bin,
      conditions: { orgId: '${orgId}' },
    },
    {
      action: A.Read,
      subject: [S.Gateway, S.Sensor, S.AlertRule, S.Telemetry, S.Kiosk],
    },
    {
      action: A.Execute,
      subject: S.DeviceCommand,
      inverted: true,
      reason: 'Device commands are issued by IoT Supervisor.',
    },
    // Read-only on money so ops can chase unpaid pickups without touching ledgers.
    {
      action: A.Read,
      subject: [S.Payment, S.Invoice, S.Subscription, S.Tariff],
      conditions: { orgId: '${orgId}' },
      fields: ['id', 'status', 'amount', 'currency', 'customerId', 'createdAt'],
    },
    {
      action: [A.Read, A.Create],
      subject: S.EcoPointsAdjustment,
      limits: { maxPointsPerDay: 5000 },
      requires: ['reason'],
    },
    { action: A.Read, subject: [S.EcoPointsLedger, S.Reward, S.Ticket] },
    {
      action: [A.Create, A.Update],
      subject: S.Broadcast,
      requires: ['approval'],
      reason: 'Outbound SMS/WhatsApp blasts need a second approver.',
    },
    {
      action: [A.Read, A.Export],
      subject: S.Report,
      conditions: { category: { in: ['operations', 'sustainability'] } },
      requires: ['reason'],
    },
    { action: A.Read, subject: S.AuditLog, conditions: { orgId: '${orgId}' } },
  ],

  /* ------------------------------------------------------------------ */
  FINANCE_ADMIN: [
    // Billing-side view of the customer only — no operational or contact PII.
    {
      action: A.Read,
      subject: S.Customer,
      conditions: { orgId: '${orgId}' },
      fields: [
        'id',
        'legalName',
        'billingEmail',
        'tin',
        'billingAddress',
        'subscriptionId',
        'balance',
      ],
    },
    {
      action: [A.Read, A.Create, A.Update],
      subject: [S.Invoice, S.Subscription],
      conditions: { orgId: '${orgId}' },
    },
    {
      action: [A.Read, A.Update],
      subject: S.Payment,
      conditions: { orgId: '${orgId}' },
    },
    {
      action: [A.Read, A.Create],
      subject: S.Refund,
      limits: { maxAmountRwf: 50_000 },
      requires: ['reason'],
    },
    {
      action: A.Approve,
      subject: S.Refund,
      requires: ['mfa'],
      reason:
        'Refunds above the cap require an approver distinct from the initiator.',
    },
    {
      action: [A.Read, A.Create, A.Update],
      subject: S.Tariff,
      requires: ['approval'],
    },
    {
      action: [A.Read, A.Create, A.Execute],
      subject: [S.Payout, S.Reconciliation],
      requires: ['mfa'],
    },
    {
      action: A.Read,
      subject: [S.CollectionRequest, S.Route, S.Vehicle],
      conditions: { orgId: '${orgId}' },
      fields: ['id', 'status', 'completedAt', 'weightKg', 'costCenter'],
    },
    { action: A.Read, subject: S.EcoPointsLedger },
    {
      action: [A.Create, A.Update],
      subject: S.EcoPointsAdjustment,
      inverted: true,
      reason:
        'Loyalty balances are adjusted by Operations or Support, never Finance.',
    },
    { action: A.Read, subject: S.Ticket, conditions: { category: 'billing' } },
    {
      action: [A.Read, A.Export],
      subject: S.Report,
      conditions: { category: { in: ['finance', 'revenue', 'tax'] } },
      requires: ['reason'],
    },
    { action: A.Read, subject: S.AuditLog, conditions: { domain: 'finance' } },
    {
      action: [A.Read, A.Execute],
      subject: [S.DeviceCommand, S.Gateway, S.Sensor],
      inverted: true,
      reason: 'No device-plane access from Finance.',
    },
  ],

  /* ------------------------------------------------------------------ */
  IOT_SUPERVISOR: [
    // Full device plane, across regions (US915 Michigan + EU868 Kigali fleets).
    {
      action: [A.Read, A.Create, A.Update, A.Delete],
      subject: [S.Gateway, S.Sensor],
      requires: ['reason'],
    },
    {
      action: [A.Read, A.Create, A.Update],
      subject: [S.Bin, S.AlertRule, S.Kiosk],
    },
    {
      action: A.Execute,
      subject: S.DeviceCommand,
      requires: ['mfa', 'reason'],
      reason: 'Downlinks, reboots and firmware pushes are step-up protected.',
    },
    { action: [A.Read, A.Create, A.Update], subject: S.ModelVersion },
    {
      action: A.Execute,
      subject: S.ModelVersion,
      requires: ['approval'],
      reason: 'Promoting a sorting model to kiosks needs a second approver.',
    },
    { action: [A.Read, A.Export], subject: S.Telemetry },
    {
      action: A.Read,
      subject: [S.CollectionRequest, S.Route, S.Vehicle, S.TrackingSession],
    },
    // Device work never needs subscriber identity.
    {
      action: A.Read,
      subject: S.Customer,
      fields: ['id', 'orgId', 'siteName'],
      maskFields: ['phone', 'email', 'nationalId'],
    },
    {
      action: A.Read,
      subject: [S.Payment, S.Invoice, S.Subscription, S.Payout, S.Refund],
      inverted: true,
      reason: 'No financial data on the device-operations role.',
    },
    { action: A.Read, subject: S.ApiKey, conditions: { scope: 'iot' } },
    {
      action: [A.Read, A.Update],
      subject: S.Integration,
      conditions: { type: { in: ['chirpstack', 'mqtt', 'kiosk-sync'] } },
      requires: ['mfa'],
    },
    {
      action: [A.Read, A.Export],
      subject: S.Report,
      conditions: {
        category: { in: ['device-health', 'fill-level', 'sorting-accuracy'] },
      },
    },
    { action: A.Read, subject: S.AuditLog, conditions: { domain: 'device' } },
  ],

  /* ------------------------------------------------------------------ */
  SUPPORT_AGENT: [
    // Read-mostly, heavily masked, no bulk egress.
    {
      action: A.Read,
      subject: S.Customer,
      conditions: { orgId: '${orgId}' },
      maskFields: ['nationalId', 'momoAccount', 'billingAddress'],
    },
    {
      action: A.Update,
      subject: S.Customer,
      fields: ['phone', 'email', 'preferredLanguage', 'notes'],
      requires: ['reason'],
    },
    {
      action: [A.Read, A.Create],
      subject: S.CollectionRequest,
      conditions: { orgId: '${orgId}' },
      reason: 'May raise a pickup on the customer’s behalf.',
    },
    {
      action: A.Update,
      subject: S.CollectionRequest,
      fields: ['notes', 'preferredWindow'],
    },
    { action: [A.Read, A.Create, A.Update], subject: S.Ticket },
    {
      action: A.Read,
      subject: S.Conversation,
      conditions: { customerId: { in: '${assignedCustomerIds}' } },
      maskFields: ['pinEntry', 'otp'],
    },
    {
      action: A.Create,
      subject: S.Broadcast,
      conditions: { templateOnly: true, audienceSize: { lte: 1 } },
      reason: 'Single-recipient resends only — no campaigns.',
    },
    {
      action: A.Read,
      subject: [S.Payment, S.Invoice],
      conditions: { orgId: '${orgId}' },
      fields: ['id', 'status', 'amount', 'currency', 'createdAt'],
      maskFields: ['momoRef', 'payerMsisdn'],
    },
    {
      action: [A.Create, A.Update],
      subject: [S.Refund, S.Payout, S.Tariff],
      inverted: true,
      reason: 'Support cannot move money; escalate to Finance Admin.',
    },
    {
      action: A.Create,
      subject: S.EcoPointsAdjustment,
      limits: { maxPointsPerDay: 500 },
      requires: ['reason', 'approval'],
    },
    {
      action: A.Read,
      subject: [S.EcoPointsLedger, S.Reward, S.Bin, S.Route, S.Schedule],
    },
    { action: A.Execute, subject: S.DeviceCommand, inverted: true },
    {
      action: A.Export,
      subject: [S.Report, S.Customer, S.Telemetry],
      inverted: true,
      reason: 'Bulk export is disabled for the support role.',
    },
    {
      action: A.Read,
      subject: S.Report,
      conditions: { category: 'support-queue', ownerId: '${userId}' },
    },
  ],
};

/** Flattened `resource:action` strings, useful for seeding and for UI gating. */
export function flattenPermissions(role: RoleKey): string[] {
  const out = new Set<string>();
  for (const g of ROLE_POLICIES[role]) {
    if (g.inverted) continue;
    const actions = Array.isArray(g.action) ? g.action : [g.action];
    const subjects = Array.isArray(g.subject) ? g.subject : [g.subject];
    for (const s of subjects)
      for (const a of actions) out.add(`${s.toLowerCase()}:${a}`);
  }
  return [...out].sort();
}
