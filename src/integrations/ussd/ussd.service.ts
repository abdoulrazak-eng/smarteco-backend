import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import {
  CommunicationChannel,
  CommunicationDirection,
  CommunicationStatus,
  PickupStatus,
  WasteType,
  TimeSlot,
} from '@prisma/client';
import { RedisService } from '../../infrastructure/redis/redis.service';

@Injectable()
export class UssdService {
  private readonly logger = new Logger(UssdService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.logger.log('USSD service initialized');
  }

  // ─── PROCESS USSD REQUEST ───────────────────────
  // Africa's Talking USSD callback handler
  // Returns: string starting with "CON " (continue) or "END " (terminate)

  async processRequest(
    sessionId: string,
    phone: string,
    text: string,
  ): Promise<string> {
    const sessionKey = `ussd:session:${sessionId}`;
    await this.redis.set(
      sessionKey,
      { phone, lastText: text, lastSeenAt: new Date().toISOString() },
      300,
    );
    // Parse input — Africa's Talking sends cumulative text separated by *
    const inputs = text ? text.split('*') : [];
    const level = inputs.length;

    this.logger.log(
      `USSD [${sessionId}] Phone: ${phone}, Level: ${level}, Input: "${text}"`,
    );

    try {
      // First level — show main menu
      if (text === '') {
        const response = this.mainMenu();
        await this.logUssd(phone, text, response);
        return response;
      }

      const firstChoice = inputs[0];

      switch (firstChoice) {
        case '1':
          return this.withLog(
            phone,
            text,
            this.handleSchedulePickup(phone, inputs, level),
          );
        case '2':
          return this.withLog(phone, text, this.handleCheckStatus(phone));
        case '3':
          return this.withLog(phone, text, this.handleEcoPoints(phone));
        case '4':
          return this.withLog(phone, text, this.handleBinStatus(phone));
        case '5':
          return this.withLog(
            phone,
            text,
            Promise.resolve(this.handleContactSupport()),
          );
        default:
          return this.withLog(
            phone,
            text,
            Promise.resolve('END Invalid option. Please try again.'),
          );
      }
    } catch (error) {
      this.logger.error(
        `USSD Error [${sessionId}]: ${(error as Error).message}`,
      );
      return 'END An error occurred. Please try again later.';
    }
  }

  // ─── MENU SCREENS ───────────────────────────────

  private mainMenu(): string {
    return [
      'CON Welcome to Ejova 🌿',
      '1. Schedule a Pickup',
      '2. Check Pickup Status',
      '3. View EcoPoints',
      '4. Check Bin Status',
      '5. Contact Support',
    ].join('\n');
  }

  // ─── 1. SCHEDULE PICKUP ─────────────────────────

  private async handleSchedulePickup(
    phone: string,
    inputs: string[],
    level: number,
  ): Promise<string> {
    // Level 1: first choice was "1", ask waste type
    if (level === 1) {
      return [
        'CON Select waste type:',
        '1. Organic',
        '2. Recyclable',
        '3. E-Waste',
        '4. General',
        '5. Hazardous',
      ].join('\n');
    }

    // Level 2: waste type selected, ask time slot
    if (level === 2) {
      return [
        'CON Select time slot:',
        '1. Morning (8-10 AM)',
        '2. Late Morning (10-12 PM)',
        '3. Afternoon (2-4 PM)',
        '4. Late Afternoon (4-6 PM)',
      ].join('\n');
    }

    // Level 3: time slot selected — confirm and create
    if (level === 3) {
      const wasteTypes = [
        'ORGANIC',
        'RECYCLABLE',
        'EWASTE',
        'GENERAL',
        'HAZARDOUS',
      ];
      const timeSlots = [
        'MORNING_8_10',
        'MORNING_10_12',
        'AFTERNOON_2_4',
        'AFTERNOON_4_6',
      ];
      const wasteLabels = [
        'Organic',
        'Recyclable',
        'E-Waste',
        'General',
        'Hazardous',
      ];
      const timeLabels = ['8-10 AM', '10-12 PM', '2-4 PM', '4-6 PM'];

      const wasteIdx = parseInt(inputs[1]) - 1;
      const timeIdx = parseInt(inputs[2]) - 1;

      if (
        wasteIdx < 0 ||
        wasteIdx >= wasteTypes.length ||
        timeIdx < 0 ||
        timeIdx >= timeSlots.length
      ) {
        return 'END Invalid selection. Please try again.';
      }

      // Find user
      const user = await this.prisma.user.findUnique({ where: { phone } });
      if (!user) {
        return 'END You are not registered. Please download the Ejova app to register first.';
      }

      // Generate reference
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code = '';
      for (let i = 0; i < 5; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      const reference = `ECO-${code}`;

      // Schedule for tomorrow
      const scheduledDate = new Date();
      scheduledDate.setDate(scheduledDate.getDate() + 1);
      scheduledDate.setHours(0, 0, 0, 0);

      // Get last known address
      const lastPickup = await this.prisma.pickup.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: { address: true, latitude: true, longitude: true },
      });

      const idempotencyKey = `ussd:idemp:${phone}:${inputs.join('*')}`;
      const alreadyProcessed = await this.redis.get<{ done: boolean }>(
        idempotencyKey,
      );
      if (alreadyProcessed?.done) {
        return 'END Your pickup request was already received. Please check status in a moment.';
      }

      await this.prisma.pickup.create({
        data: {
          reference,
          userId: user.id,
          wasteType: wasteTypes[wasteIdx] as WasteType,
          scheduledDate,
          timeSlot: timeSlots[timeIdx] as TimeSlot,
          status: PickupStatus.PENDING,
          address: lastPickup?.address || 'Via USSD',
          latitude: lastPickup?.latitude || 0,
          longitude: lastPickup?.longitude || 0,
          notes: 'Scheduled via USSD',
        },
      });
      await this.redis.set(idempotencyKey, { done: true }, 120);

      return `END Pickup scheduled!\nRef: ${reference}\nType: ${wasteLabels[wasteIdx]}\nTime: Tomorrow ${timeLabels[timeIdx]}\n\nOpen Ejova app for details.`;
    }

    return 'END Invalid input. Please try again.';
  }

  // ─── 2. CHECK PICKUP STATUS ─────────────────────

  private async handleCheckStatus(phone: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      return 'END You are not registered. Download the Ejova app to register.';
    }

    // Show active pickup
    const activePickup = await this.prisma.pickup.findFirst({
      where: {
        userId: user.id,
        status: {
          in: [
            PickupStatus.PENDING,
            PickupStatus.CONFIRMED,
            PickupStatus.COLLECTOR_ASSIGNED,
            PickupStatus.EN_ROUTE,
            PickupStatus.ARRIVED,
            PickupStatus.IN_PROGRESS,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        collector: {
          include: {
            user: { select: { firstName: true } },
          },
        },
      },
    });

    if (!activePickup) {
      return 'END No active pickups found.\n\nDial again to schedule one.';
    }

    const statusLabels: Record<string, string> = {
      PENDING: '⏳ Pending',
      CONFIRMED: '✅ Confirmed',
      COLLECTOR_ASSIGNED: '👤 Collector Assigned',
      EN_ROUTE: '🚛 Collector En Route',
      ARRIVED: '📍 Collector Arrived',
      IN_PROGRESS: '♻️ In Progress',
    };

    let msg = `END Pickup ${activePickup.reference}\nType: ${activePickup.wasteType}\nStatus: ${statusLabels[activePickup.status] || activePickup.status}`;

    if (activePickup.collector?.user?.firstName) {
      msg += `\nCollector: ${activePickup.collector.user.firstName}`;
    }

    return msg;
  }

  // ─── 3. VIEW ECOPOINTS ──────────────────────────

  private async handleEcoPoints(phone: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      return 'END You are not registered. Download the Ejova app to register.';
    }

    const totalPoints = await this.prisma.ecoPointTransaction.aggregate({
      where: { userId: user.id },
      _sum: { points: true },
    });

    const points = totalPoints._sum.points || 0;
    const tier =
      points >= 5000
        ? 'ECO CHAMPION 🏆'
        : points >= 1000
          ? 'ECO WARRIOR ⭐'
          : 'ECO STARTER 🌱';

    const completedPickups = await this.prisma.pickup.count({
      where: { userId: user.id, status: 'COMPLETED' },
    });

    return `END Your EcoPoints: ${points}\nTier: ${tier}\nCompleted Pickups: ${completedPickups}\n\nKeep collecting to level up! 🌿`;
  }

  // ─── 4. BIN STATUS ──────────────────────────────

  private async handleBinStatus(phone: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      return 'END You are not registered. Download the Ejova app to register.';
    }

    const bins = await this.prisma.bin.findMany({
      where: { userId: user.id },
      select: { wasteType: true, fillLevel: true, status: true },
      orderBy: { wasteType: 'asc' },
    });

    if (bins.length === 0) {
      return 'END No bins found.\n\nContact support for setup.';
    }

    const fillBar = (level: number): string => {
      if (level >= 80) return '🔴';
      if (level >= 50) return '🟡';
      return '🟢';
    };

    let msg = 'END Your Bins:\n';
    bins.forEach((bin) => {
      msg += `${fillBar(bin.fillLevel)} ${bin.wasteType}: ${bin.fillLevel}%\n`;
    });

    return msg;
  }

  // ─── 5. CONTACT SUPPORT ─────────────────────────

  private handleContactSupport(): string {
    return [
      'END Ejova Support:',
      '📞 Call: +250788000000',
      '📧 Email: support@smarteco.rw',
      '💬 WhatsApp: +250788000000',
      '',
      'Hours: Mon-Sat 7AM-7PM',
    ].join('\n');
  }

  private async withLog(
    phone: string,
    input: string,
    responsePromise: Promise<string>,
  ) {
    const response = await responsePromise;
    await this.logUssd(phone, input, response);
    return response;
  }

  private async logUssd(phone: string, input: string, response: string) {
    await this.prisma.communicationLog.create({
      data: {
        channel: CommunicationChannel.USSD,
        direction: CommunicationDirection.INBOUND,
        status: CommunicationStatus.RECEIVED,
        phone,
        subject: 'USSD Session',
        message: input || '<start>',
        metadata: { response },
      },
    });
  }
}
