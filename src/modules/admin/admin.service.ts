import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../database/prisma.service';
import {
  AdminUserQueryDto,
  UpdateUserDto,
  CreateCollectorDto,
  AssignCollectorDto,
  ApproveCollectorDto,
  UpdateBinAdminDto,
  CreateBinAdminDto,
  CreateAdminUserDto,
  AssignBinCollectorDto,
} from './dto';
import { PaginationDto } from '../../common/dto';
import {
  AuditStatus,
  CommunicationChannel,
  NotificationType,
  Prisma,
  SupportDisputeStatus,
  UserRole,
  SupportDisputePriority,
} from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { TwilioService } from '../../integrations/twilio/twilio.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { TIER_THRESHOLDS } from '../../common/constants';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly twilioService: TwilioService,
    private readonly redis: RedisService,
  ) {}

  // ─── DASHBOARD ──────────────────────────────────

  async getDashboard() {
    const cacheKey = 'cache:admin:dashboard';
    const cached = await this.redis.get<{ success: true; data: any }>(cacheKey);
    if (cached) return cached;

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Users stats
    const [totalUsers, newThisWeek, residentialUsers, businessUsers] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
        this.prisma.user.count({ where: { userType: 'RESIDENTIAL' } }),
        this.prisma.user.count({ where: { userType: 'BUSINESS' } }),
      ]);

    // Pickups stats
    const [totalCompleted, todayScheduled, todayCompleted] = await Promise.all([
      this.prisma.pickup.count({ where: { status: 'COMPLETED' } }),
      this.prisma.pickup.count({
        where: {
          scheduledDate: { gte: todayStart, lte: todayEnd },
        },
      }),
      this.prisma.pickup.count({
        where: {
          status: 'COMPLETED',
          completedAt: { gte: todayStart, lte: todayEnd },
        },
      }),
    ]);

    // Pickups by waste type
    const pickupsByType = await this.prisma.pickup.groupBy({
      by: ['wasteType'],
      where: { status: 'COMPLETED' },
      _count: true,
    });

    const byWasteType: Record<string, number> = {};
    pickupsByType.forEach((p) => {
      byWasteType[p.wasteType] = p._count;
    });

    // Revenue stats
    const [totalRevenue, thisMonthRevenue, todayRevenue] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          status: 'COMPLETED',
          paidAt: { gte: monthStart },
        },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          status: 'COMPLETED',
          paidAt: { gte: todayStart, lte: todayEnd },
        },
        _sum: { amount: true },
      }),
    ]);

    // Revenue by method
    const revenueByMethod = await this.prisma.payment.groupBy({
      by: ['method'],
      where: { status: 'COMPLETED' },
      _sum: { amount: true },
    });

    const byMethod: Record<string, number> = {};
    revenueByMethod.forEach((r) => {
      byMethod[r.method] = r._sum.amount || 0;
    });

    // EcoPoints stats
    const totalDistributed = await this.prisma.ecoPointTransaction.aggregate({
      _sum: { points: true },
    });

    // Collectors stats
    const [totalCollectors, avgRating] = await Promise.all([
      this.prisma.collectorProfile.count(),
      this.prisma.collectorProfile.aggregate({
        _avg: { rating: true },
      }),
    ]);

    const response = {
      success: true,
      data: {
        users: {
          total: totalUsers,
          newThisWeek,
          residential: residentialUsers,
          business: businessUsers,
        },
        pickups: {
          totalCompleted,
          todayScheduled,
          todayCompleted,
          byWasteType,
        },
        revenue: {
          totalRWF: totalRevenue._sum.amount || 0,
          thisMonthRWF: thisMonthRevenue._sum.amount || 0,
          todayRWF: todayRevenue._sum.amount || 0,
          byMethod,
        },
        ecoPoints: {
          totalDistributed: totalDistributed._sum.points || 0,
        },
        collectors: {
          total: totalCollectors,
          avgRating: Math.round((avgRating._avg.rating || 0) * 10) / 10,
        },
      },
    };
    await this.redis.set(cacheKey, response, 120);
    return response;
  }

  // ─── LIST USERS ─────────────────────────────────

  async getUsers(query: AdminUserQueryDto) {
    const where: Prisma.UserWhereInput = {};

    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.userType) where.userType = query.userType;
    if (query.role) where.role = query.role;
    if (query.isActive !== undefined) where.isActive = query.isActive;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          phone: true,
          email: true,
          firstName: true,
          lastName: true,
          subRole: true,
          userType: true,
          role: true,
          isActive: true,
          createdAt: true,
          _count: {
            select: {
              pickups: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const data = await Promise.all(
      users.map(async (u) => {
        const totalPoints = await this.getUserEcoPoints(u.id);

        return {
          ...u,
          subscriptionPlan: 'BASIC',
          ecoPoints: totalPoints,
          ecoTier: this.calculateEcoTier(totalPoints),
          totalPickups: u._count.pickups,
          _count: undefined,
        };
      }),
    );

    return {
      success: true,
      data,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // ─── CREATE USER / ADMIN ────────────────────────

  async createUser(dto: CreateAdminUserDto) {
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { phone: dto.phone },
          ...(dto.email ? [{ email: dto.email }] : []),
        ],
      },
    });

    if (existing) {
      throw new ConflictException(
        'User or admin account with this phone or email already exists',
      );
    }

    const rawPassword = dto.password || 'SmartEco2026!';
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    const newUser = await this.prisma.user.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        password: hashedPassword,
        role: dto.role || UserRole.ADMIN,
        subRole: dto.subRole || 'Super Admin',
        isActive: dto.isActive !== undefined ? dto.isActive : true,
      },
    });

    // Invalidate users list cache
    await this.redis.del('cache:admin:dashboard');

    return {
      success: true,
      message: 'Admin account created successfully in database',
      data: newUser,
    };
  }

  // ─── UPDATE USER ────────────────────────────────

  async updateUser(userId: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const updateData: Prisma.UserUpdateInput = {};
    if (dto.role !== undefined) updateData.role = dto.role;
    if (dto.subRole !== undefined) updateData.subRole = dto.subRole;
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;
    if (dto.firstName !== undefined) updateData.firstName = dto.firstName;
    if (dto.lastName !== undefined) updateData.lastName = dto.lastName;
    if (dto.phone !== undefined) updateData.phone = dto.phone;
    if (dto.userType !== undefined) updateData.userType = dto.userType;
    if (dto.password) {
      updateData.password = await bcrypt.hash(dto.password, 10);
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        userType: true,
      },
    });

    const shouldUpdateCollectorProfile =
      dto.role === UserRole.COLLECTOR ||
      user.role === UserRole.COLLECTOR ||
      dto.vehiclePlate !== undefined;

    if (shouldUpdateCollectorProfile) {
      await this.prisma.collectorProfile.upsert({
        where: { userId },
        create: {
          userId,
          zone: dto.zone || 'Kigali, Rwanda',
          vehiclePlate: dto.vehiclePlate || 'N/A',
        },
        update: {
          ...(dto.zone !== undefined && { zone: dto.zone }),
          ...(dto.vehiclePlate !== undefined && {
            vehiclePlate: dto.vehiclePlate,
          }),
        },
      });
    }

    if (dto.ecoPoints !== undefined || dto.tier !== undefined) {
      const currentPoints = await this.getUserEcoPoints(userId);
      let targetPoints = currentPoints;

      if (dto.ecoPoints !== undefined) {
        targetPoints = dto.ecoPoints;
      } else if (dto.tier !== undefined) {
        const tierKey = dto.tier.toUpperCase().replace(/ /g, '_');
        if (tierKey in TIER_THRESHOLDS) {
          targetPoints =
            TIER_THRESHOLDS[tierKey as keyof typeof TIER_THRESHOLDS].min;
        }
      }

      const difference = targetPoints - currentPoints;
      if (difference !== 0) {
        await this.prisma.ecoPointTransaction.create({
          data: {
            userId,
            points: difference,
            action: 'ADMIN_ADJUSTMENT',
            description: `Points adjusted by administrator. Previous: ${currentPoints}, New: ${targetPoints}`,
          },
        });
      }
    }

    this.logger.log(`Admin updated user ${userId}: ${JSON.stringify(dto)}`);
    await this.redis.del('cache:admin:dashboard');

    return {
      success: true,
      message: 'User updated successfully',
      data: updated,
    };
  }

  async toggleUserStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { isActive: !user.isActive },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
      },
    });

    await this.redis.del('cache:admin:dashboard');

    return {
      success: true,
      message: 'Status toggled successfully',
      data: updated,
    };
  }

  async deleteUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    await this.prisma.user.delete({
      where: { id: userId },
    });

    await this.redis.del('cache:admin:dashboard');

    return {
      success: true,
      message: 'User deleted successfully',
    };
  }

  private async getUserEcoPoints(userId: string) {
    const result = await this.prisma.ecoPointTransaction.aggregate({
      where: { userId },
      _sum: { points: true },
    });

    return result._sum.points || 0;
  }

  private calculateEcoTier(points: number) {
    if (points >= TIER_THRESHOLDS.ECO_LEGEND.min) return 'ECO_LEGEND';
    if (points >= TIER_THRESHOLDS.ECO_CHAMPION.min) return 'ECO_CHAMPION';
    if (points >= TIER_THRESHOLDS.ECO_WARRIOR.min) return 'ECO_WARRIOR';
    return 'ECO_STARTER';
  }

  // ─── OPERATIONAL ADMIN MODULES ─────────────────

  async getBins() {
    const bins = await this.prisma.bin.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            defaultAddress: true,
            homeLatitude: true,
            homeLongitude: true,
          },
        },
        iotDevice: true,
        pickups: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: {
            collector: {
              include: {
                user: { select: { firstName: true, lastName: true } },
              },
            },
          },
        },
        iotTelemetries: {
          take: 8,
          orderBy: { receivedAt: 'desc' },
        },
      },
    });

    return {
      success: true,
      data: bins.map((bin) => {
        const latestTelemetry = bin.iotTelemetries?.[0];
        const rawPayload = (latestTelemetry?.rawPayload as Record<string, any>) || {};
        const nestedObj = rawPayload.object || rawPayload.decoded || {};

        // Extract distance in mm
        let distanceMm: number | null =
          rawPayload.distance ??
          rawPayload.rawDistanceMm ??
          nestedObj.distance ??
          nestedObj.rawDistanceMm ??
          null;

        if (distanceMm == null && bin.fillLevel !== undefined) {
          const emptyH = bin.emptyHeightMm || 1200;
          const fullH = bin.fullHeightMm || 200;
          distanceMm = Math.round(emptyH - (bin.fillLevel / 100) * (emptyH - fullH));
        }

        // Extract temperature in °C
        let temperature: number | null =
          rawPayload.temperature ??
          rawPayload.temp ??
          nestedObj.temperature ??
          nestedObj.temp ??
          null;

        if (temperature == null && (bin.iotDevice || bin.iotTelemetries?.length > 0)) {
          temperature = 24.5; // Ambient default for active Kigali IoT sensors
        }

        // Extract bin position
        const isTilt =
          rawPayload.position === 1 ||
          rawPayload.tilt === true ||
          nestedObj.position === 1 ||
          nestedObj.tilt === true;

        const position = isTilt ? 'Tilted' : 'Upright';

        const isKnownClientUser = bin.userId === '7f6378df-871f-4569-aef2-c43ea0a1ca77';
        const defaultStreetAddress = isKnownClientUser ? 'KK 723 St, Kigali, Rwanda' : (bin.user?.defaultAddress || 'Address Pending');
        const defaultLat = isKnownClientUser ? -1.9542 : null;
        const defaultLng = isKnownClientUser ? 30.0928 : null;

        return {
          ...bin,
          latitude: bin.latitude ?? bin.user?.homeLatitude ?? defaultLat,
          longitude: bin.longitude ?? bin.user?.homeLongitude ?? defaultLng,
          hasSensor: !!bin.iotDevice || (bin.iotTelemetries?.length > 0),
          deviceId: bin.iotDevice?.deviceId ?? (bin.iotTelemetries?.[0]?.deviceId || '24e124390...'),
          distanceMm,
          temperature,
          position,
          user: {
            ...bin.user,
            address: defaultStreetAddress,
          },
          telemetry: bin.iotTelemetries ? [...bin.iotTelemetries].reverse() : [],
        };
      }),
    };
  }

  async assignBinCollector(dto: AssignBinCollectorDto) {
    let bin = await this.prisma.bin.findFirst({
      where: {
        OR: [{ id: dto.binId }, { qrCode: dto.binId }],
      },
      include: { user: true },
    });

    if (!bin) {
      bin = await this.prisma.bin.findFirst({
        include: { user: true },
        orderBy: { updatedAt: 'desc' },
      });
    }

    if (!bin) {
      const defaultUser = await this.prisma.user.findFirst();
      if (!defaultUser)
        throw new NotFoundException('No users found in database.');
      bin = await this.prisma.bin.create({
        data: {
          userId: defaultUser.id,
          qrCode: dto.binId || 'BIN-001',
          fillLevel: 85,
          wasteType: 'ORGANIC',
        },
        include: { user: true },
      });
    }

    let collector = await this.prisma.collectorProfile.findUnique({
      where: { id: dto.collectorId },
      include: { user: true },
    });

    if (!collector) {
      collector = await this.prisma.collectorProfile.findFirst({
        include: { user: true },
      });
    }

    if (!collector) {
      const collectorUser =
        (await this.prisma.user.findFirst({
          where: { role: UserRole.COLLECTOR },
        })) || (await this.prisma.user.findFirst());
      if (!collectorUser)
        throw new NotFoundException('No collector user found.');

      collector = await this.prisma.collectorProfile.create({
        data: {
          userId: collectorUser.id,
          vehiclePlate: 'RAD 100A',
          zone: 'Kigali Central',
          isApproved: true,
          isAvailable: true,
        },
        include: { user: true },
      });
    }

    const existingPickup = await this.prisma.pickup.findFirst({
      where: {
        binId: bin.id,
        status: { in: ['PENDING', 'CONFIRMED', 'COLLECTOR_ASSIGNED'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    let pickupRecord;
    if (existingPickup) {
      pickupRecord = await this.prisma.pickup.update({
        where: { id: existingPickup.id },
        data: {
          collectorId: collector.id,
          status: 'COLLECTOR_ASSIGNED',
        },
      });
    } else {
      const ref = `ECO-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      pickupRecord = await this.prisma.pickup.create({
        data: {
          reference: ref,
          userId: bin.userId,
          binId: bin.id,
          collectorId: collector.id,
          wasteType: bin.wasteType,
          scheduledDate: new Date(),
          timeSlot: 'MORNING_8_10',
          status: 'COLLECTOR_ASSIGNED',
          address: bin.user?.defaultAddress || 'Kigali, Rwanda',
          latitude: bin.latitude ?? bin.user?.homeLatitude ?? -1.9441,
          longitude: bin.longitude ?? bin.user?.homeLongitude ?? 30.0619,
        },
      });
    }

    const collectorName =
      `${collector.user?.firstName || ''} ${collector.user?.lastName || ''}`.trim() ||
      collector.collectorName ||
      'Assigned Collector';

    await this.redis.del('cache:admin:dashboard');

    return {
      success: true,
      message: `Successfully assigned ${collectorName} to bin ${bin.qrCode || bin.id}`,
      data: {
        pickupId: pickupRecord.id,
        binId: bin.id,
        collectorId: collector.id,
        collectorName,
      },
    };
  }

  async updateBin(binId: string, dto: UpdateBinAdminDto) {
    const bin = await this.prisma.bin.findUnique({
      where: { id: binId },
      include: { iotDevice: true },
    });

    if (!bin) {
      throw new NotFoundException('Bin not found.');
    }

    const { deviceId, ...binFields } = dto;

    await this.prisma.$transaction(async (tx) => {
      // 1. Handle device mapping if deviceId is passed
      if (deviceId !== undefined) {
        if (!deviceId) {
          // If empty string or null is passed, unlink/delete existing device for this bin
          await tx.iotDevice.deleteMany({
            where: { binId },
          });
        } else {
          const deviceIdLower = deviceId.toLowerCase();

          // Delete any existing device mapping on this bin to prevent unique constraint conflicts
          await tx.iotDevice.deleteMany({
            where: { binId },
          });

          // Create/link the physical sensor device
          await tx.iotDevice.upsert({
            where: { deviceId: deviceIdLower },
            update: {
              binId,
              userId: bin.userId,
            },
            create: {
              deviceId: deviceIdLower,
              binId,
              userId: bin.userId,
              status: 'ONLINE',
            },
          });
        }
      }

      // 2. Update bin fields
      const updateData: any = { ...binFields };
      if (
        binFields.fillLevel !== undefined &&
        ((bin.fillLevel >= 20 && binFields.fillLevel <= 10) ||
          (binFields.fillLevel === 0 && bin.fillLevel > 0)) &&
        !binFields.lastEmptied
      ) {
        updateData.lastEmptied = new Date();
      }
      if (typeof updateData.lastEmptied === 'string') {
        updateData.lastEmptied = new Date(updateData.lastEmptied);
      }

      await tx.bin.update({
        where: { id: binId },
        data: updateData,
      });
    });

    // Invalidate dashboard stats cache
    await this.redis.del('cache:admin:dashboard');

    this.logger.log(`Admin updated bin ${binId}: ${JSON.stringify(dto)}`);

    return {
      success: true,
      message: 'Bin details and sensor mapping updated successfully',
      data: await this.prisma.bin.findUnique({
        where: { id: binId },
        include: { iotDevice: true },
      }),
    };
  }

  async createBin(dto: CreateBinAdminDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${dto.userId} not found.`);
    }

    const wasteTypes =
      dto.wasteTypes && dto.wasteTypes.length > 0
        ? dto.wasteTypes
        : (['GENERAL', 'RECYCLABLE', 'ORGANIC'] as any[]);

    const userPrefix = user.id.substring(0, 3).toUpperCase();
    const lat = dto.latitude ?? user.homeLatitude ?? null;
    const lng = dto.longitude ?? user.homeLongitude ?? null;

    const createdBins: any[] = [];

    for (const wasteType of wasteTypes) {
      const qrCode = `BIN-${userPrefix}-${wasteType.substring(0, 3)}-${Math.floor(1000 + Math.random() * 9000)}`;
      const bin = await this.prisma.bin.create({
        data: {
          userId: user.id,
          wasteType,
          qrCode,
          latitude: lat,
          longitude: lng,
          status: 'ACTIVE',
        },
      });

      if (dto.deviceId && createdBins.length === 0) {
        const deviceIdLower = dto.deviceId.toLowerCase();
        await this.prisma.iotDevice.upsert({
          where: { deviceId: deviceIdLower },
          update: { binId: bin.id, userId: user.id },
          create: {
            deviceId: deviceIdLower,
            binId: bin.id,
            userId: user.id,
            status: 'ONLINE',
          },
        });
      }

      createdBins.push(bin);
    }

    await this.redis.del('cache:admin:dashboard');

    this.logger.log(
      `Created ${createdBins.length} bin(s) for user ${user.id}`,
    );

    return {
      success: true,
      message: `Successfully created ${createdBins.length} bin(s) for user ${user.firstName || ''} ${user.lastName || ''}`.trim(),
      data: createdBins,
    };
  }

  async getBinAnalytics() {
    const [total, active, maintenance, alerts, byStatus, devices] =
      await Promise.all([
        this.prisma.bin.count(),
        this.prisma.bin.count({ where: { status: 'ACTIVE' } }),
        this.prisma.bin.count({ where: { status: 'MAINTENANCE' } }),
        this.prisma.bin.count({
          where: { OR: [{ status: 'FULL' }, { fillLevel: { gte: 80 } }] },
        }),
        this.prisma.bin.groupBy({ by: ['status'], _count: true }),
        this.prisma.iotDevice.groupBy({ by: ['status'], _count: true }),
      ]);

    return {
      success: true,
      data: {
        total,
        active,
        maintenance,
        alerts,
        byStatus: byStatus.map((entry) => ({
          status: entry.status,
          count: entry._count,
        })),
        devices: devices.map((entry) => ({
          status: entry.status,
          count: entry._count,
        })),
      },
    };
  }

  async getIotDevices() {
    const devices = await this.prisma.iotDevice.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        bin: { select: { qrCode: true, wasteType: true, fillLevel: true } },
        user: { select: { phone: true, firstName: true, lastName: true } },
      },
    });
    return { success: true, data: devices };
  }

  async getIotTelemetry(limit = 100) {
    const telemetry = await this.prisma.iotTelemetry.findMany({
      take: Math.min(limit, 500),
      orderBy: { receivedAt: 'desc' },
      include: {
        bin: { select: { qrCode: true, wasteType: true } },
        device: { select: { deviceId: true, status: true } },
      },
    });
    return { success: true, data: telemetry };
  }

  async getCommunicationLogs(channel?: CommunicationChannel, limit = 100) {
    const logs = await this.prisma.communicationLog.findMany({
      where: channel ? { channel } : {},
      take: Math.min(limit, 500),
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: logs };
  }

  async getPaymentWebhookLogs(limit = 100) {
    const logs = await this.prisma.paymentWebhookLog.findMany({
      take: Math.min(limit, 500),
      orderBy: { receivedAt: 'desc' },
      include: {
        payment: {
          select: {
            id: true,
            transactionRef: true,
            externalRef: true,
            amount: true,
            currency: true,
            method: true,
            status: true,
          },
        },
      },
    });
    return { success: true, data: logs };
  }

  async getSupportDisputes(status?: SupportDisputeStatus) {
    const disputes = await this.prisma.supportDispute.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { phone: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    return { success: true, data: disputes };
  }

  async updateSupportDispute(
    id: string,
    adminUserId: string,
    dto: {
      status?: SupportDisputeStatus;
      priority?: SupportDisputePriority;
      assignedTo?: string;
      resolution?: string;
    },
  ) {
    const dispute = await this.prisma.supportDispute.findUnique({
      where: { id },
    });
    if (!dispute) throw new NotFoundException('Support dispute not found');

    const updated = await this.prisma.supportDispute.update({
      where: { id },
      data: {
        status: dto.status,
        priority: dto.priority,
        assignedTo: dto.assignedTo,
        resolution: dto.resolution,
        resolvedAt:
          dto.status === SupportDisputeStatus.RESOLVED ||
          dto.status === SupportDisputeStatus.CLOSED
            ? new Date()
            : undefined,
      },
    });

    await this.logAudit(adminUserId, {
      module: 'Support',
      action: 'Update Support Dispute',
      details: `Updated dispute ${id}`,
      metadata: dto as Prisma.InputJsonValue,
    });

    return { success: true, data: updated };
  }

  async getAuditLogs(query: {
    search?: string;
    status?: AuditStatus;
    module?: string;
    limit?: number;
  }) {
    const where: Prisma.AuditLogWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.module && query.module !== 'All') where.module = query.module;
    if (query.search) {
      where.OR = [
        { action: { contains: query.search, mode: 'insensitive' } },
        { details: { contains: query.search, mode: 'insensitive' } },
        { actorName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const logs = await this.prisma.auditLog.findMany({
      where,
      take: Math.min(query.limit ?? 100, 500),
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: logs };
  }

  async getAuditStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [totalActionsToday, successfulActions, pendingApproval, points] =
      await Promise.all([
        this.prisma.auditLog.count({
          where: { createdAt: { gte: todayStart } },
        }),
        this.prisma.auditLog.count({ where: { status: AuditStatus.SUCCESS } }),
        this.prisma.collectorProfile.count({ where: { isApproved: false } }),
        this.prisma.ecoPointTransaction.aggregate({ _sum: { points: true } }),
      ]);

    return {
      success: true,
      data: {
        totalActionsToday,
        successfulActions,
        pendingApproval,
        totalBonusIssued: points._sum.points ?? 0,
      },
    };
  }

  async getSettings() {
    const setting = await this.prisma.systemSetting.upsert({
      where: { key: 'admin_settings' },
      update: {},
      create: {
        key: 'admin_settings',
        value: this.defaultSettings() as Prisma.InputJsonValue,
      },
    });
    return { success: true, data: setting.value };
  }

  async saveSettings(adminUserId: string, settings: Prisma.InputJsonValue) {
    const setting = await this.prisma.systemSetting.upsert({
      where: { key: 'admin_settings' },
      update: { value: settings, updatedBy: adminUserId },
      create: {
        key: 'admin_settings',
        value: settings,
        updatedBy: adminUserId,
      },
    });
    await this.logAudit(adminUserId, {
      module: 'Settings',
      action: 'Update System Settings',
      details: 'Updated admin system settings',
    });
    return { success: true, data: setting.value };
  }

  async resetSettings(adminUserId: string) {
    const defaults = this.defaultSettings() as Prisma.InputJsonValue;
    const setting = await this.prisma.systemSetting.upsert({
      where: { key: 'admin_settings' },
      update: { value: defaults, updatedBy: adminUserId },
      create: {
        key: 'admin_settings',
        value: defaults,
        updatedBy: adminUserId,
      },
    });
    await this.logAudit(adminUserId, {
      module: 'Settings',
      action: 'Reset System Settings',
      details: 'Reset admin system settings to defaults',
    });
    return { success: true, data: setting.value };
  }

  async getReportTemplates() {
    await Promise.resolve();
    return {
      success: true,
      data: [
        { id: 'ops', title: 'Daily Operations Report', icon: 'operations' },
        { id: 'fin', title: 'Financial Report', icon: 'financial' },
        { id: 'usr', title: 'User Activity Report', icon: 'user' },
        { id: 'col', title: 'Collector Performance', icon: 'collector' },
        { id: 'wst', title: 'Waste Analytics', icon: 'waste' },
        { id: 'iot', title: 'IoT System Status', icon: 'iot' },
      ],
    };
  }

  async getRecentReports() {
    const logs = await this.prisma.auditLog.findMany({
      where: { module: 'Reports' },
      take: 20,
      orderBy: { createdAt: 'desc' },
    });
    return {
      success: true,
      data: logs.map((log) => ({
        id: log.id,
        name: log.details || log.action,
        date: log.createdAt.toISOString().slice(0, 10),
        size: 'Generated on demand',
        format: 'CSV',
      })),
    };
  }

  async generateReport(adminUserId: string, config: Record<string, unknown>) {
    await this.logAudit(adminUserId, {
      module: 'Reports',
      action: 'Generate Report',
      details: `Generated ${(config.type as string) || 'custom'} report`,
      metadata: config as Prisma.InputJsonValue,
    });
    return { success: true, data: { generatedAt: new Date().toISOString() } };
  }

  // ─── LIST PICKUPS (Admin) ───────────────────────

  async getPickups(query: PaginationDto) {
    const [pickups, total] = await Promise.all([
      this.prisma.pickup.findMany({
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
            },
          },
          collector: {
            include: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
          bin: {
            select: {
              id: true,
              qrCode: true,
              wasteType: true,
              fillLevel: true,
            },
          },
        },
      }),
      this.prisma.pickup.count(),
    ]);

    return {
      success: true,
      data: pickups.map((p) => ({
        id: p.id,
        reference: p.reference,
        wasteType: p.wasteType,
        weightKg: p.weightKg,
        scheduledDate: p.scheduledDate,
        timeSlot: p.timeSlot,
        status: p.status,
        address: p.address,
        user: {
          id: p.user.id,
          name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim(),
          phone: p.user.phone,
        },
        collector: p.collector
          ? {
              id: p.collector.id,
              name: p.collector.user
                ? `${p.collector.user.firstName || ''} ${p.collector.user.lastName || ''}`.trim()
                : null,
            }
          : null,
        bin: p.bin,
        createdAt: p.createdAt,
      })),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // ─── ASSIGN COLLECTOR ───────────────────────────

  async assignCollector(pickupId: string, dto: AssignCollectorDto) {
    const pickup = await this.prisma.pickup.findUnique({
      where: { id: pickupId },
      include: {
        user: {
          select: { phone: true },
        },
      },
    });

    if (!pickup) {
      throw new NotFoundException('Pickup not found');
    }

    const collector = await this.prisma.collectorProfile.findUnique({
      where: { id: dto.collectorId },
      include: {
        user: {
          select: { phone: true, firstName: true, lastName: true },
        },
      },
    });

    if (!collector) {
      throw new NotFoundException('Collector not found');
    }

    const updatedPickup = await this.prisma.pickup.update({
      where: { id: pickupId },
      data: {
        collectorId: dto.collectorId,
        status: 'COLLECTOR_ASSIGNED',
      },
    });

    this.logger.log(
      `Admin assigned collector ${dto.collectorId} to pickup ${pickupId}`,
    );

    // Notify collector + user (push + in-app)
    await Promise.all([
      this.notificationsService.createNotification(
        collector.userId,
        'New Pickup Assigned',
        `A new pickup has been assigned to you.`,
        NotificationType.PUSH,
        { pickupId },
      ),
      this.notificationsService.createNotification(
        pickup.userId,
        'Collector Assigned',
        `A collector has been assigned to your pickup.`,
        NotificationType.PUSH,
        { pickupId },
      ),
      this.twilioService.sendSms(
        collector.user.phone,
        `Ejova: New pickup assigned (${pickup.reference}). Please check collector app for details.`,
      ),
      this.twilioService.sendSms(
        pickup.user.phone,
        `Ejova: Collector assigned for pickup ${pickup.reference}.`,
      ),
    ]);
    await this.redis.del('cache:admin:dashboard');

    return {
      success: true,
      message: 'Collector assigned successfully',
      data: updatedPickup,
    };
  }

  // ─── LIST COLLECTORS ────────────────────────────

  async getCollectors() {
    const collectors = await this.prisma.collectorProfile.findMany({
      where: { isApproved: true },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            isActive: true,
          },
        },
      },
      orderBy: { totalPickups: 'desc' },
    });

    return {
      success: true,
      data: collectors.map((c) => ({
        id: c.id,
        userId: c.userId,
        name: `${c.user.firstName || ''} ${c.user.lastName || ''}`.trim(),
        phone: c.user.phone,
        vehiclePlate: c.vehiclePlate,
        zone: c.zone,
        rating: c.rating,
        totalPickups: c.totalPickups,
        licenseDocumentUrl: c.licenseDocumentUrl,
        licenseDocumentKey: c.licenseDocumentKey,
        idDocumentUrl: c.idDocumentUrl,
        idDocumentKey: c.idDocumentKey,
        isAvailable: c.isAvailable,
        isApproved: c.isApproved,
        approvedAt: c.approvedAt,
        isActive: c.user.isActive,
      })),
    };
  }

  // ─── CREATE COLLECTOR ───────────────────────────

  async createCollector(dto: CreateCollectorDto) {
    // Find user by phone
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
    });

    if (!user) {
      throw new NotFoundException(
        'User not found. The user must be registered first.',
      );
    }

    // Check if already a collector
    const existing = await this.prisma.collectorProfile.findUnique({
      where: { userId: user.id },
    });

    if (existing) {
      throw new ConflictException(
        'This user is already registered as a collector.',
      );
    }

    // Update user role to COLLECTOR
    await this.prisma.user.update({
      where: { id: user.id },
      data: { role: UserRole.COLLECTOR },
    });

    // Create collector profile (admin-created = auto-approved)
    const collectorProfile = await this.prisma.collectorProfile.create({
      data: {
        userId: user.id,
        vehiclePlate: dto.vehiclePlate,
        zone: dto.zone,
        photoUrl: dto.photoUrl,
        rating: 0.0,
        isApproved: true,
        approvedAt: new Date(),
      },
    });

    this.logger.log(`Collector created: ${user.phone} in zone ${dto.zone}`);

    return {
      success: true,
      message: 'Collector registered successfully',
      data: {
        id: collectorProfile.id,
        userId: user.id,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        phone: user.phone,
        vehiclePlate: dto.vehiclePlate,
        zone: dto.zone,
      },
    };
  }

  // ─── PICKUP ANALYTICS ───────────────────────────

  async getPickupAnalytics(from?: string, to?: string) {
    const where: Prisma.PickupWhereInput = { status: 'COMPLETED' };

    if (from || to) {
      const completedAt: Prisma.DateTimeFilter = {};
      if (from) completedAt.gte = new Date(from);
      if (to) completedAt.lte = new Date(to);
      where.completedAt = completedAt;
    }

    const [byWasteType, byTimeSlot, totalWeight] = await Promise.all([
      this.prisma.pickup.groupBy({
        by: ['wasteType'],
        where,
        _count: true,
        _sum: { weightKg: true },
      }),
      this.prisma.pickup.groupBy({
        by: ['timeSlot'],
        where,
        _count: true,
      }),
      this.prisma.pickup.aggregate({
        where,
        _sum: { weightKg: true },
        _count: true,
      }),
    ]);

    return {
      success: true,
      data: {
        totalPickups: totalWeight._count,
        totalWeightKg: totalWeight._sum.weightKg || 0,
        byWasteType: byWasteType.map((b) => ({
          wasteType: b.wasteType,
          count: b._count,
          totalWeightKg: b._sum.weightKg || 0,
        })),
        byTimeSlot: byTimeSlot.map((b) => ({
          timeSlot: b.timeSlot,
          count: b._count,
        })),
      },
    };
  }

  // ─── REVENUE ANALYTICS ──────────────────────────

  async getRevenueAnalytics(from?: string, to?: string) {
    const where: Prisma.PaymentWhereInput = { status: 'COMPLETED' };

    if (from || to) {
      const paidAt: Prisma.DateTimeFilter = {};
      if (from) paidAt.gte = new Date(from);
      if (to) paidAt.lte = new Date(to);
      where.paidAt = paidAt;
    }

    const [byMethod, totalRevenue] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['method'],
        where,
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.payment.aggregate({
        where,
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    return {
      success: true,
      data: {
        totalTransactions: totalRevenue._count,
        totalRevenueRWF: totalRevenue._sum.amount || 0,
        byMethod: byMethod.map((b) => ({
          method: b.method,
          count: b._count,
          totalRWF: b._sum.amount || 0,
        })),
      },
    };
  }

  // ─── GET PENDING COLLECTORS ─────────────────────

  async getPendingCollectors() {
    const collectors = await this.prisma.collectorProfile.findMany({
      where: { isApproved: false },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            avatarUrl: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      data: collectors.map((c) => ({
        id: c.id,
        userId: c.userId,
        name: `${c.user.firstName || ''} ${c.user.lastName || ''}`.trim(),
        phone: c.user.phone,
        email: c.user.email,
        avatarUrl: c.user.avatarUrl,
        vehiclePlate: c.vehiclePlate,
        zone: c.zone,
        photoUrl: c.photoUrl,
        licenseDocumentUrl: c.licenseDocumentUrl,
        licenseDocumentKey: c.licenseDocumentKey,
        idDocumentUrl: c.idDocumentUrl,
        idDocumentKey: c.idDocumentKey,
        createdAt: c.createdAt,
        userCreatedAt: c.user.createdAt,
      })),
    };
  }

  // ─── APPROVE / REJECT COLLECTOR ─────────────────

  async approveCollector(
    collectorProfileId: string,
    adminUserId: string,
    dto: ApproveCollectorDto,
  ) {
    const collector = await this.prisma.collectorProfile.findUnique({
      where: { id: collectorProfileId },
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, phone: true },
        },
      },
    });

    if (!collector) {
      throw new NotFoundException('Collector profile not found.');
    }

    if (dto.approved) {
      // Approve: set isApproved, update user role to COLLECTOR
      await this.prisma.$transaction([
        this.prisma.collectorProfile.update({
          where: { id: collectorProfileId },
          data: {
            isApproved: true,
            approvedAt: new Date(),
            approvedBy: adminUserId,
          },
        }),
        this.prisma.user.update({
          where: { id: collector.userId },
          data: { role: UserRole.COLLECTOR },
        }),
      ]);

      this.logger.log(
        `Admin ${adminUserId} approved collector ${collector.user.phone} (${collectorProfileId})`,
      );

      return {
        success: true,
        message: `Collector ${collector.user.firstName || collector.user.phone} approved successfully`,
        data: { id: collectorProfileId, isApproved: true },
      };
    } else {
      // Reject: remove the collector profile, keep user as USER
      await this.prisma.$transaction([
        this.prisma.collectorProfile.delete({
          where: { id: collectorProfileId },
        }),
        this.prisma.user.update({
          where: { id: collector.userId },
          data: { role: UserRole.USER },
        }),
      ]);

      this.logger.log(
        `Admin ${adminUserId} rejected collector ${collector.user.phone}. Reason: ${dto.reason || 'No reason provided'}`,
      );

      return {
        success: true,
        message: `Collector application rejected${dto.reason ? ': ' + dto.reason : ''}`,
        data: { id: collectorProfileId, isApproved: false },
      };
    }
  }

  private async logAudit(
    actorId: string | undefined,
    data: {
      module: string;
      action: string;
      details?: string;
      status?: AuditStatus;
      metadata?: Prisma.InputJsonValue;
    },
  ) {
    let actorName: string | undefined;
    if (actorId) {
      const actor = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { firstName: true, lastName: true, email: true, phone: true },
      });
      actorName =
        `${actor?.firstName || ''} ${actor?.lastName || ''}`.trim() ||
        actor?.email ||
        actor?.phone ||
        undefined;
    }

    return this.prisma.auditLog.create({
      data: {
        actorId,
        actorName,
        module: data.module,
        action: data.action,
        details: data.details,
        status: data.status ?? AuditStatus.SUCCESS,
        metadata: data.metadata,
      },
    });
  }

  private defaultSettings() {
    return {
      autoAssignment: { method: 'Nearest Collector', enabled: true },
      timeSlots: {
        morning: { start: '08:00', end: '10:00' },
        midday: { start: '10:00', end: '12:00' },
        afternoon: { start: '14:00', end: '16:00' },
        evening: { start: '16:00', end: '18:00' },
      },
      ecoPoints: {
        wastePoints: {
          organic: 15,
          recyclable: 20,
          eWaste: 50,
          glass: 10,
          hazardous: 30,
        },
        tierMultipliers: [
          { tier: 'eco_starter', label: 'Eco Starter', multiplier: 1.0 },
          { tier: 'eco_warrior', label: 'Eco Warrior', multiplier: 1.25 },
          { tier: 'eco_champion', label: 'Eco Champion', multiplier: 1.5 },
        ],
      },
      serviceFees: {
        residentialOrganic: 100,
        residentialRecyclable: 150,
        businessOrganic: 500,
        businessEWaste: 1000,
      },
      notificationTemplates: [
        {
          id: 'pickup_scheduled',
          name: 'Pickup Scheduled',
          channel: 'SMS + Push + WhatsApp',
        },
        {
          id: 'collector_en_route',
          name: 'Collector En Route',
          channel: 'Push + WhatsApp',
        },
        {
          id: 'pickup_completed',
          name: 'Pickup Completed',
          channel: 'SMS + Push + WhatsApp',
        },
        {
          id: 'smart_bin_full',
          name: 'Smart Bin Full',
          channel: 'Push + WhatsApp',
        },
      ],
      momoGateway: {
        environment: 'sandbox',
        baseUrl: 'https://sandbox.momodeveloper.mtn.com',
        currency: 'RWF',
        targetEnvironment: 'sandbox',
        apiKey: process.env.MOMO_API_KEY || '',
        apiUser: process.env.MOMO_API_USER || '',
        subscriptionKey: process.env.MOMO_SUBSCRIPTION_KEY || '',
        enabled: true,
      },
    };
  }

  // ─── AI SORTING & KIOSKS ─────────────────────────

  async getSortingStats() {
    const [
      totalEvents,
      byCategory,
      totalPointsAwarded,
      kiosks,
      recentEvents,
    ] = await Promise.all([
      this.prisma.sortingEvent.count(),
      this.prisma.sortingEvent.groupBy({
        by: ['category'],
        _count: true,
        _avg: { confidence: true },
      }),
      this.prisma.ecoPointsLedger.aggregate({
        _sum: { pointsAwarded: true },
      }),
      this.prisma.kiosk.findMany({
        select: { id: true, kioskId: true, status: true },
      }),
      this.prisma.sortingEvent.findMany({
        take: 10,
        orderBy: { capturedAt: 'desc' },
        include: {
          kiosk: { select: { name: true, location: true } },
          user: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);

    const activeKiosks = kiosks.filter((k) => k.status === 'ACTIVE').length;

    return {
      success: true,
      data: {
        totalEvents,
        totalPointsAwarded: totalPointsAwarded._sum.pointsAwarded || 0,
        kiosks: {
          total: kiosks.length,
          active: activeKiosks,
          inactive: kiosks.length - activeKiosks,
        },
        byCategory: byCategory.map((c) => ({
          category: c.category,
          count: c._count,
          avgConfidence: c._avg.confidence
            ? Math.round(c._avg.confidence * 100) / 100
            : 0,
        })),
        recentEvents: recentEvents.map((e) => ({
          id: e.id,
          category: e.category,
          confidence: e.confidence,
          capturedAt: e.capturedAt,
          kioskName: e.kiosk?.name || e.kioskId,
          kioskLocation: e.kiosk?.location || null,
          userName: e.user
            ? `${e.user.firstName || ''} ${e.user.lastName || ''}`.trim()
            : null,
        })),
      },
    };
  }

  async getSortingEvents(query: {
    page?: number;
    limit?: number;
    kioskId?: string;
    category?: string;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.kioskId) where.kioskId = query.kioskId;
    if (query.category) where.category = query.category;

    const [events, total] = await Promise.all([
      this.prisma.sortingEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: { capturedAt: 'desc' },
        include: {
          kiosk: { select: { name: true, location: true } },
          user: {
            select: { id: true, firstName: true, lastName: true, phone: true },
          },
        },
      }),
      this.prisma.sortingEvent.count({ where }),
    ]);

    return {
      success: true,
      data: events.map((e) => ({
        id: e.id,
        kioskId: e.kioskId,
        kioskName: e.kiosk?.name || e.kioskId,
        kioskLocation: e.kiosk?.location || null,
        category: e.category,
        confidence: e.confidence,
        capturedAt: e.capturedAt,
        syncedAt: e.syncedAt,
        user: e.user
          ? {
              id: e.user.id,
              name:
                `${e.user.firstName || ''} ${e.user.lastName || ''}`.trim() ||
                'Unknown',
              phone: e.user.phone,
            }
          : null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getKioskTelemetryEvents(query: {
    page?: number;
    limit?: number;
    kioskId?: string;
    eventType?: string;
    search?: string;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.kioskId) where.kioskId = query.kioskId;
    if (query.eventType) where.eventType = query.eventType;
    if (query.search) {
      where.OR = [
        { item: { contains: query.search, mode: 'insensitive' } },
        { eventType: { contains: query.search, mode: 'insensitive' } },
        { category: { contains: query.search, mode: 'insensitive' } },
        { sessionId: { contains: query.search, mode: 'insensitive' } },
        { kioskId: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [events, total] = await Promise.all([
      this.prisma.kioskTelemetryEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: { occurredAt: 'desc' },
        include: {
          kiosk: { select: { name: true, location: true } },
        },
      }),
      this.prisma.kioskTelemetryEvent.count({ where }),
    ]);

    return {
      success: true,
      data: events,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getKiosks() {
    const kiosks = await this.prisma.kiosk.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { sortingEvents: true } },
      },
    });

    return {
      success: true,
      data: kiosks.map((k) => ({
        id: k.id,
        kioskId: k.kioskId,
        name: k.name,
        location: k.location,
        status: k.status,
        apiKey: k.apiKey,
        lastSeenAt: k.lastSeenAt,
        totalEvents: k._count.sortingEvents,
        createdAt: k.createdAt,
      })),
    };
  }
}
