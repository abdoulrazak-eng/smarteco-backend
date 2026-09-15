import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { UpdateProfileDto, UpdateFcmTokenDto } from './dto';
import { TIER_THRESHOLDS } from '../../common/constants';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AddressValidationService } from '../../common/services/address-validation.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ─── GET PROFILE ─────────────────────────────────

  async getProfile(userId: string) {
    const cacheKey = `cache:user:profile:${userId}`;
    const cached = await this.redis.get<{ success: true; data: any }>(cacheKey);
    if (cached) return cached;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        email: true,
        firstName: true,
        lastName: true,
        userType: true,
        role: true,
        subRole: true,
        referralCode: true,
        avatarUrl: true,
        defaultAddress: true,
        homeLatitude: true,
        homeLongitude: true,
        isActive: true,
        createdAt: true,
        collectorProfile: {
          select: {
            id: true,
            isApproved: true,
            collectorName: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Get EcoPoints stats
    const totalPoints = await this.getTotalPoints(userId);
    const tier = this.calculateTier(totalPoints);
    const tierInfo = TIER_THRESHOLDS[tier];

    // Get pickup count
    const totalPickups = await this.prisma.pickup.count({
      where: { userId, status: 'COMPLETED' },
    });

    const response = {
      success: true,
      data: {
        ...user,
        isApproved: user.isActive,
        ecoPoints: totalPoints,
        ecoTier: tier,
        tierMultiplier: tierInfo.multiplier,
        totalPickups,
        memberSince: user.createdAt,
      },
    };
    await this.redis.set(cacheKey, response, 60);
    return response;
  }

  // ─── UPDATE PROFILE ──────────────────────────────

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    // Check email uniqueness if being updated
    if (dto.email) {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (existingUser && existingUser.id !== userId) {
        throw new ConflictException('Email already in use by another user');
      }
    }

    let validatedAddress: string | undefined;
    if (dto.defaultAddress !== undefined) {
      validatedAddress = AddressValidationService.validateAddress(dto.defaultAddress);
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.userType !== undefined && { userType: dto.userType }),
        ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl }),
        ...(validatedAddress !== undefined && {
          defaultAddress: validatedAddress,
        }),
        ...(dto.homeLatitude !== undefined && {
          homeLatitude: dto.homeLatitude,
        }),
        ...(dto.homeLongitude !== undefined && {
          homeLongitude: dto.homeLongitude,
        }),
      },
      select: {
        id: true,
        phone: true,
        email: true,
        firstName: true,
        lastName: true,
        userType: true,
        role: true,
        referralCode: true,
        avatarUrl: true,
        defaultAddress: true,
        homeLatitude: true,
        homeLongitude: true,
        createdAt: true,
        collectorProfile: {
          select: {
            id: true,
            isApproved: true,
            collectorName: true,
          },
        },
      },
    });

    const totalPoints = await this.getTotalPoints(userId);
    const tier = this.calculateTier(totalPoints);
    const tierInfo = TIER_THRESHOLDS[tier];
    const totalPickups = await this.prisma.pickup.count({
      where: { userId, status: 'COMPLETED' },
    });

    await this.redis.del(`cache:user:profile:${userId}`);
    return {
      success: true,
      message: 'Profile updated successfully',
      data: {
        ...updatedUser,
        ecoPoints: totalPoints,
        ecoTier: tier,
        tierMultiplier: tierInfo.multiplier,
        totalPickups,
        memberSince: updatedUser.createdAt,
      },
    };
  }

  // ─── GET REFERRAL INFO ───────────────────────────

  async getReferralInfo(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Get referred users
    const referredUsers = await this.prisma.user.findMany({
      where: { referredBy: userId },
      select: {
        firstName: true,
        lastName: true,
        createdAt: true,
        pickups: {
          where: { status: 'COMPLETED' },
          take: 1,
          select: { id: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate points earned from referrals
    const referralPoints = await this.prisma.ecoPointTransaction.aggregate({
      where: {
        userId,
        action: 'REFERRAL',
      },
      _sum: { points: true },
    });

    return {
      success: true,
      data: {
        referralCode: user.referralCode,
        referralLink: `https://smarteco.rw/ref/${user.referralCode}`,
        totalReferred: referredUsers.length,
        pointsEarned: referralPoints._sum.points || 0,
        referredUsers: referredUsers.map((u) => ({
          firstName: u.firstName,
          lastName: u.lastName,
          joinedAt: u.createdAt,
          firstPickupCompleted: u.pickups.length > 0,
        })),
      },
    };
  }

  // ─── UPDATE FCM TOKEN ────────────────────────────

  async updateFcmToken(userId: string, dto: UpdateFcmTokenDto) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: dto.fcmToken },
    });
    await this.redis.del(`cache:user:profile:${userId}`);

    return {
      success: true,
      message: 'FCM token updated successfully',
    };
  }

  // ─── DELETE ACCOUNT ──────────────────────────────

  async deleteAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    this.logger.log(`Initiating account deletion for user: ${userId} (${user.phone})`);

    // In a transaction, cancel active pickups, revoke tokens, clean notifications, and anonymize user
    await this.prisma.$transaction(async (tx) => {
      // 1. Cancel any active or pending pickups
      await tx.pickup.updateMany({
        where: {
          userId,
          status: { in: ['PENDING', 'CONFIRMED', 'COLLECTOR_ASSIGNED'] },
        },
        data: {
          status: 'CANCELLED',
          cancelReason: 'Account deleted by user',
          cancelledAt: new Date(),
        },
      });

      // 2. Delete all refresh tokens
      await tx.refreshToken.deleteMany({
        where: { userId },
      });

      // 3. Delete notifications
      await tx.notification.deleteMany({
        where: { userId },
      });

      // 4. Delete bins if not referenced in pickups, or inactivate them
      try {
        await tx.bin.deleteMany({
          where: { userId },
        });
      } catch {
        await tx.bin.updateMany({
          where: { userId },
          data: { status: 'INACTIVE' },
        });
      }

      // 5. Purge PII and anonymize User record (maintains relational integrity while removing all personal identity)
      const timestamp = Date.now();
      const anonymizedPhone = `+deleted_${timestamp}_${userId.substring(0, 6)}`;

      await tx.user.update({
        where: { id: userId },
        data: {
          phone: anonymizedPhone,
          email: null,
          firstName: 'Deleted',
          lastName: 'User',
          avatarUrl: null,
          defaultAddress: null,
          homeLatitude: null,
          homeLongitude: null,
          fcmToken: null,
          password: null,
          isActive: false,
        },
      });
    });

    // 6. Evict caches from Redis
    await this.redis.del(`cache:user:profile:${userId}`);
    await this.redis.del(`user:session:${userId}`);

    this.logger.log(`Account successfully deleted and anonymized for user: ${userId}`);

    return {
      success: true,
      message: 'Your account and personal data have been successfully deleted.',
    };
  }

  // ─── PRIVATE HELPERS ─────────────────────────────

  private async getTotalPoints(userId: string): Promise<number> {
    const result = await this.prisma.ecoPointTransaction.aggregate({
      where: { userId },
      _sum: { points: true },
    });
    return result._sum.points || 0;
  }

  private calculateTier(points: number): keyof typeof TIER_THRESHOLDS {
    if (points >= 10000) return 'ECO_LEGEND';
    if (points >= 5000) return 'ECO_CHAMPION';
    if (points >= 1000) return 'ECO_WARRIOR';
    return 'ECO_STARTER';
  }
}
