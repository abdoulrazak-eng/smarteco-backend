import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreatePickupDto, CancelPickupDto, PickupQueryDto } from './dto';

import {
  PICKUP_REFERENCE_PREFIX,
  PICKUP_REFERENCE_LENGTH,
  PICKUP_MIN_ADVANCE_HOURS,
  ECOPOINTS,
  PICKUP_PRICES,
  DEFAULT_CURRENCY,
  MAX_COLLECTOR_ASSIGNMENT_DISTANCE_KM,
} from '../../common/constants';
import {
  PickupStatus,
  WasteType,
  PaymentMethod,
  PaymentStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { MomoService } from '../../integrations/momo/momo.service';
import { AirtelService } from '../../integrations/airtel/airtel.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TwilioService } from '../../integrations/twilio/twilio.service';

type CollectorWithUser = Prisma.CollectorProfileGetPayload<{
  include: {
    user: {
      select: {
        firstName: true;
        lastName: true;
        phone: true;
      };
    };
  };
}>;

type PickupWithDetails = Prisma.PickupGetPayload<object> & {
  collector?: CollectorWithUser | null;
  payment?: Record<string, unknown> | null;
  bin?: Record<string, unknown> | null;
};

@Injectable()
export class PickupsService {
  private readonly logger = new Logger(PickupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly momoService: MomoService,
    private readonly airtelService: AirtelService,
    private readonly notificationsService: NotificationsService,
    private readonly twilioService: TwilioService,
  ) {}

  // ─── CREATE PICKUP ──────────────────────────────

  async createPickup(userId: string, dto: CreatePickupDto) {
    const scheduledDate = dto.scheduledDate
      ? new Date(dto.scheduledDate)
      : new Date();

    // Validate bin belongs to user (if provided)
    if (dto.binId) {
      const bin = await this.prisma.bin.findUnique({
        where: { id: dto.binId },
      });
      if (!bin) {
        throw new NotFoundException('Bin not found.');
      }
      if (bin.userId !== userId) {
        throw new ForbiddenException('This bin does not belong to you.');
      }
      // Synchronize location coordinates to bin
      if (dto.latitude && dto.longitude) {
        await this.prisma.bin
          .update({
            where: { id: dto.binId },
            data: {
              latitude: dto.latitude,
              longitude: dto.longitude,
            },
          })
          .catch(() => {});
      }
    }

    // Synchronize user default location
    if (dto.latitude && dto.longitude) {
      await this.prisma.user
        .update({
          where: { id: userId },
          data: {
            homeLatitude: dto.latitude,
            homeLongitude: dto.longitude,
            ...(dto.address ? { defaultAddress: dto.address } : {}),
          },
        })
        .catch(() => {});
    }

    // Generate unique reference
    const reference = await this.generateUniqueReference();

    // Estimate points for the pickup
    const estimatedPoints = this.estimatePoints(dto.wasteType);

    const assignedCollector = await this.findNearestAvailableCollector(
      dto.latitude,
      dto.longitude,
    );

    // Calculate payment amount
    const amount = PICKUP_PRICES[dto.wasteType] || PICKUP_PRICES.GENERAL || 100;

    // Determine currency: Sandbox MoMo usually requires EUR, production uses RWF
    const isSandbox =
      process.env.MOMO_BASE_URL?.includes('sandbox') ||
      !process.env.MOMO_API_KEY;
    const currency = isSandbox ? 'EUR' : DEFAULT_CURRENCY;

    // Fetch user for phone number
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    // Determine payment method (default to MTN_MOMO)
    const method = dto.paymentMethod || PaymentMethod.MTN_MOMO;

    // Initiate Payment
    let paymentRef: string | null = null;
    try {
      this.logger.log(
        `Initiating ${method} payment for pickup ${reference}: ${amount} ${currency}`,
      );

      if (method === PaymentMethod.MTN_MOMO) {
        const momoResult = await this.momoService.requestToPay(
          amount,
          currency,
          user.phone,
          reference,
          `Waste Pickup: ${reference}`,
          `Payment for ${dto.wasteType} pickup`,
        );
        paymentRef = momoResult.referenceId;
      } else {
        const airtelResult = await this.airtelService.requestToPay(
          amount,
          currency,
          user.phone,
          reference,
        );
        paymentRef = airtelResult.referenceId;
      }
    } catch (error) {
      this.logger.error(
        `Failed to initiate ${method} payment for ${reference}: ${(error as Error).message}`,
      );
      // Fallback for demo / testing if payment gateway is unreachable
      paymentRef = `MOMO_DEMO_${Date.now()}`;
    }

    // Create the pickup and linked payment record
    const pickup = await this.prisma.pickup.create({
      data: {
        reference,
        userId,
        wasteType: dto.wasteType,
        scheduledDate,
        timeSlot: dto.timeSlot,
        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,
        notes: dto.notes,
        binId: dto.binId,
        status: assignedCollector
          ? PickupStatus.COLLECTOR_ASSIGNED
          : PickupStatus.PENDING,
        collectorId: assignedCollector?.id ?? null,
        payment: {
          create: {
            userId,
            amount,
            currency,
            method,
            status: PaymentStatus.PENDING,
            transactionRef: reference,
            externalRef: paymentRef,
          },
        },
      },
      include: {
        collector: {
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
          },
        },
        payment: true,
      },
    });

    this.logger.log(
      `Pickup created: ${reference} with payment ${paymentRef} for user ${userId}`,
    );

    // Notify user via all channels (Push, SMS, WhatsApp)
    await this.notificationsService.dispatchLifecycleNotification(
      userId,
      assignedCollector
        ? 'Pickup Scheduled - Collector Assigned'
        : 'Pickup Scheduled',
      `Ejova: Pickup ${reference} scheduled for ${dto.timeSlot}. Status: ${pickup.status}.`,
      { pickupId: pickup.id, reference: pickup.reference },
      ['IN_APP', 'PUSH', 'SMS', 'WHATSAPP'],
    );

    if (assignedCollector) {
      await this.notificationsService.createNotification(
        assignedCollector.userId,
        'New Pickup Assigned',
        `Pickup ${reference} was auto-assigned to you based on proximity.`,
        NotificationType.PUSH,
        {
          pickupId: pickup.id,
          reference: pickup.reference,
          distanceKm: assignedCollector.distanceKm,
        },
      );
    }

    return {
      success: true,
      message: 'Pickup scheduled successfully',
      data: {
        id: pickup.id,
        reference: pickup.reference,
        wasteType: pickup.wasteType,
        scheduledDate: pickup.scheduledDate,
        timeSlot: pickup.timeSlot,
        status: pickup.status,
        address: pickup.address,
        latitude: pickup.latitude,
        longitude: pickup.longitude,
        notes: pickup.notes,
        collector: pickup.collector
          ? this.formatCollector(pickup.collector)
          : null,
        payment: pickup.payment
          ? {
              id: pickup.payment.id,
              amount: pickup.payment.amount,
              currency: pickup.payment.currency,
              status: pickup.payment.status,
              transactionRef: pickup.payment.transactionRef,
            }
          : null,
        estimatedPoints,
        createdAt: pickup.createdAt,
      },
    };
  }

  // ─── GET PICKUPS (LIST) ─────────────────────────

  async getPickups(userId: string, query: PickupQueryDto) {
    const where: Prisma.PickupWhereInput = { userId };

    // Apply filters
    if (query.status) {
      where.status = query.status;
    }
    if (query.wasteType) {
      where.wasteType = query.wasteType;
    }
    if (query.from || query.to) {
      where.scheduledDate = {};
      if (query.from) {
        where.scheduledDate.gte = new Date(query.from);
      }
      if (query.to) {
        where.scheduledDate.lte = new Date(query.to);
      }
    }

    // Determine sort field (only allow safe fields)
    const allowedSortFields = [
      'createdAt',
      'scheduledDate',
      'status',
      'wasteType',
    ];
    const sortBy = allowedSortFields.includes(query.sortBy)
      ? query.sortBy
      : 'createdAt';

    const [pickups, total] = await Promise.all([
      this.prisma.pickup.findMany({
        where,
        skip: query.skip,
        take: query.limit,
        orderBy: {
          [sortBy]: query.sortOrder,
        } as Prisma.PickupOrderByWithRelationInput,
        include: {
          collector: {
            include: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                  phone: true,
                },
              },
            },
          },
          payment: {
            select: {
              id: true,
              amount: true,
              currency: true,
              status: true,
            },
          },
        },
      }),
      this.prisma.pickup.count({ where }),
    ]);

    return {
      success: true,
      data: pickups.map((p) => this.formatPickup(p)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // ─── GET SINGLE PICKUP ──────────────────────────

  async getPickup(userId: string, pickupId: string) {
    const pickup = await this.prisma.pickup.findUnique({
      where: { id: pickupId },
      include: {
        collector: {
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
          },
        },
        payment: {
          select: {
            id: true,
            amount: true,
            currency: true,
            method: true,
            status: true,
            transactionRef: true,
            paidAt: true,
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
    });

    if (!pickup) {
      throw new NotFoundException('Pickup not found.');
    }

    if (pickup.userId !== userId) {
      throw new ForbiddenException('You do not have access to this pickup.');
    }

    return {
      success: true,
      data: this.formatPickup(pickup),
    };
  }

  // ─── GET ACTIVE PICKUP ──────────────────────────

  async getActivePickup(userId: string) {
    const activeStatuses = [
      PickupStatus.PENDING,
      PickupStatus.CONFIRMED,
      PickupStatus.COLLECTOR_ASSIGNED,
      PickupStatus.EN_ROUTE,
      PickupStatus.ARRIVED,
      PickupStatus.IN_PROGRESS,
    ];

    const pickup = await this.prisma.pickup.findFirst({
      where: {
        userId,
        status: { in: activeStatuses },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        collector: {
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
          },
        },
      },
    });

    if (!pickup) {
      return {
        success: true,
        data: null,
        message: 'No active pickup found.',
      };
    }

    // Calculate ETA if collector is assigned and has location
    let eta: { minutes: number; distanceKm: number } | null = null;
    if (
      pickup.collector &&
      pickup.collector.latitude &&
      pickup.collector.longitude
    ) {
      const distanceKm = this.haversineDistance(
        pickup.collector.latitude,
        pickup.collector.longitude,
        pickup.latitude,
        pickup.longitude,
      );
      const avgSpeedKmh = 30; // average city speed
      const minutes = Math.round((distanceKm / avgSpeedKmh) * 60);

      eta = {
        minutes,
        distanceKm: Math.round(distanceKm * 10) / 10,
      };
    }

    const data = this.formatPickup(pickup);

    return {
      success: true,
      data: {
        ...data,
        eta,
      },
    };
  }

  // ─── GET COLLECTOR LOCATION (for user tracking) ──

  async getCollectorLocation(userId: string, pickupId: string) {
    const pickup = await this.prisma.pickup.findUnique({
      where: { id: pickupId },
      include: {
        collector: {
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
          },
        },
      },
    });

    if (!pickup) {
      throw new NotFoundException('Pickup not found.');
    }

    if (pickup.userId !== userId) {
      throw new ForbiddenException('You do not have access to this pickup.');
    }

    if (!pickup.collector) {
      return {
        success: true,
        data: null,
        message: 'No collector assigned yet.',
      };
    }

    // Calculate ETA
    let eta: { minutes: number; distanceKm: number } | null = null;
    if (pickup.collector.latitude && pickup.collector.longitude) {
      const distanceKm = this.haversineDistance(
        pickup.collector.latitude,
        pickup.collector.longitude,
        pickup.latitude,
        pickup.longitude,
      );
      const avgSpeedKmh = 30;
      const minutes = Math.round((distanceKm / avgSpeedKmh) * 60);
      eta = {
        minutes,
        distanceKm: Math.round(distanceKm * 10) / 10,
      };
    }

    return {
      success: true,
      data: {
        collector: {
          id: pickup.collector.id,
          name: `${pickup.collector.user.firstName || ''} ${pickup.collector.user.lastName || ''}`.trim(),
          phone: pickup.collector.user.phone,
          vehiclePlate: pickup.collector.vehiclePlate,
          rating: pickup.collector.rating,
          latitude: pickup.collector.latitude,
          longitude: pickup.collector.longitude,
        },
        pickupStatus: pickup.status,
        eta,
      },
    };
  }

  // ─── CANCEL PICKUP ──────────────────────────────

  async cancelPickup(userId: string, pickupId: string, dto: CancelPickupDto) {
    const pickup = await this.prisma.pickup.findUnique({
      where: { id: pickupId },
    });

    if (!pickup) {
      throw new NotFoundException('Pickup not found.');
    }

    if (pickup.userId !== userId) {
      throw new ForbiddenException('You do not have access to this pickup.');
    }

    // Only PENDING or CONFIRMED pickups can be cancelled
    const cancellableStatuses: PickupStatus[] = [
      PickupStatus.PENDING,
      PickupStatus.CONFIRMED,
    ];

    if (!cancellableStatuses.includes(pickup.status)) {
      throw new BadRequestException(
        `Cannot cancel a pickup with status "${pickup.status}". Only PENDING or CONFIRMED pickups can be cancelled.`,
      );
    }

    await this.prisma.pickup.update({
      where: { id: pickupId },
      data: {
        status: PickupStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: dto.reason || 'Cancelled by user',
      },
    });

    this.logger.log(
      `Pickup ${pickup.reference} cancelled by user ${userId}. Reason: ${dto.reason || 'No reason provided'}`,
    );

    return {
      success: true,
      message: 'Pickup cancelled successfully',
    };
  }

  // ─── PRIVATE HELPERS ────────────────────────────

  private async generateUniqueReference(): Promise<string> {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let reference: string;
    let exists = true;

    // Keep generating until we get a unique one
    while (exists) {
      let code = '';
      for (let i = 0; i < PICKUP_REFERENCE_LENGTH; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      reference = `${PICKUP_REFERENCE_PREFIX}${code}`;

      const existing = await this.prisma.pickup.findUnique({
        where: { reference },
      });
      exists = !!existing;
    }

    return reference!;
  }

  private async findNearestAvailableCollector(
    latitude: number,
    longitude: number,
  ) {
    const collectors = await this.prisma.collectorProfile.findMany({
      where: {
        isApproved: true,
        isAvailable: true,
        latitude: { not: null },
        longitude: { not: null },
      },
      select: {
        id: true,
        userId: true,
        latitude: true,
        longitude: true,
        totalPickups: true,
      },
    });

    const ranked = collectors
      .filter(
        (collector) =>
          collector.latitude != null && collector.longitude != null,
      )
      .map((collector) => ({
        ...collector,
        distanceKm: this.haversineDistance(
          latitude,
          longitude,
          collector.latitude!,
          collector.longitude!,
        ),
      }))
      .filter(
        (collector) =>
          collector.distanceKm <= MAX_COLLECTOR_ASSIGNMENT_DISTANCE_KM,
      )
      .sort((a, b) => {
        if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
        return a.totalPickups - b.totalPickups;
      });

    return ranked[0] ?? null;
  }

  private haversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const radiusKm = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return radiusKm * c;
  }

  private toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  private estimatePoints(wasteType: WasteType): number {
    // Returns estimated points per pickup (assuming ~1kg)
    const pointsMap: Record<string, number> = {
      ORGANIC: ECOPOINTS.ORGANIC_PER_KG,
      RECYCLABLE: ECOPOINTS.RECYCLABLE_PER_KG,
      EWASTE: ECOPOINTS.EWASTE_PER_ITEM,
      GENERAL: ECOPOINTS.GENERAL_PER_KG,
      GLASS: ECOPOINTS.GLASS_PER_KG,
      HAZARDOUS: ECOPOINTS.HAZARDOUS_PER_ITEM,
      LANDFILL: ECOPOINTS.LANDFILL_PER_KG,
    };
    return pointsMap[wasteType] || ECOPOINTS.GENERAL_PER_KG || 5;
  }

  private formatCollector(collector: CollectorWithUser) {
    return {
      id: collector.id,
      name: collector.user
        ? `${collector.user.firstName || ''} ${collector.user.lastName || ''}`.trim()
        : null,
      phone: collector.user?.phone || null,
      photoUrl: collector.photoUrl,
      vehiclePlate: collector.vehiclePlate,
      rating: collector.rating,
      latitude: collector.latitude,
      longitude: collector.longitude,
    };
  }

  private formatPickup(pickup: PickupWithDetails) {
    return {
      id: pickup.id,
      reference: pickup.reference,
      wasteType: pickup.wasteType,
      weightKg: pickup.weightKg,
      scheduledDate: pickup.scheduledDate,
      timeSlot: pickup.timeSlot,
      status: pickup.status,
      address: pickup.address,
      latitude: pickup.latitude,
      longitude: pickup.longitude,
      notes: pickup.notes,
      collector: pickup.collector
        ? this.formatCollector(pickup.collector)
        : null,
      payment: (pickup.payment as Record<string, unknown>) || null,
      bin: (pickup.bin as Record<string, unknown>) || null,
      completedAt: pickup.completedAt,
      cancelledAt: pickup.cancelledAt,
      cancelReason: pickup.cancelReason,
      createdAt: pickup.createdAt,
    };
  }
}
