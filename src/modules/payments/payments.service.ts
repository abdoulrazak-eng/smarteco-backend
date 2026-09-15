import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { MomoService } from '../../integrations/momo/momo.service';
import { AirtelService } from '../../integrations/airtel/airtel.service';
import { InitiatePaymentDto, PaymentMethodEnum } from './dto';
import { PaymentStatus, PaymentMethod, Prisma } from '@prisma/client';
import { PaginationDto } from '../../common/dto';
import { v4 as uuidv4 } from 'uuid';

export interface WebhookBody {
  externalId?: string;
  status?: string;
  reason?: string;
  transaction?: {
    id?: string;
    status_code?: string;
    message?: string;
  };
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly momoService: MomoService,
    private readonly airtelService: AirtelService,
  ) {}

  // ─── INITIATE PAYMENT ───────────────────────────

  async initiatePayment(userId: string, dto: InitiatePaymentDto) {
    // Validate pickup exists and belongs to user
    const pickup = await this.prisma.pickup.findUnique({
      where: { id: dto.pickupId },
    });

    if (!pickup) {
      throw new NotFoundException('Pickup not found.');
    }

    if (pickup.userId !== userId) {
      throw new ForbiddenException('This pickup does not belong to you.');
    }

    // Check if payment already exists for this pickup
    const existingPayment = await this.prisma.payment.findUnique({
      where: { pickupId: dto.pickupId },
    });

    if (existingPayment && existingPayment.status === PaymentStatus.COMPLETED) {
      throw new BadRequestException(
        'Payment for this pickup has already been completed.',
      );
    }

    // Map DTO enum to Prisma enum
    const method =
      dto.method === PaymentMethodEnum.MOMO
        ? PaymentMethod.MTN_MOMO
        : PaymentMethod.AIRTEL_MONEY;

    const transactionRef = `PAY-${uuidv4().substring(0, 8).toUpperCase()}`;

    // Create payment record
    const payment = await this.prisma.payment.create({
      data: {
        pickupId: dto.pickupId,
        userId,
        amount: dto.amount,
        currency: 'RWF',
        method,
        status: PaymentStatus.PENDING,
        transactionRef,
      },
    });

    // Initiate mobile money request
    let externalRef: string;

    try {
      if (dto.method === PaymentMethodEnum.MOMO) {
        const result = await this.momoService.requestToPay(
          dto.amount,
          'RWF',
          dto.phone,
          transactionRef,
          `Ejova Pickup ${pickup.reference}`,
          `Payment for waste pickup ${pickup.reference}`,
        );
        externalRef = result.referenceId;
      } else {
        const result = await this.airtelService.requestToPay(
          dto.amount,
          'RWF',
          dto.phone,
          transactionRef,
        );
        // Airtel status checks expect the provider transaction id when available.
        externalRef = result.transactionId || result.referenceId;
      }

      // Update payment with provider reference
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { externalRef },
      });

      this.logger.log(
        `Payment initiated: ${transactionRef} via ${dto.method} for pickup ${pickup.reference}`,
      );

      return {
        success: true,
        message: `Payment request sent to your ${dto.method === PaymentMethodEnum.MOMO ? 'MTN MoMo' : 'Airtel Money'} phone. Please approve the prompt on your device.`,
        data: {
          paymentId: payment.id,
          transactionRef,
          externalRef,
          amount: dto.amount,
          currency: 'RWF',
          method: dto.method,
          status: 'PENDING',
        },
      };
    } catch (error) {
      // Mark payment as failed
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });

      this.logger.error(
        `Payment initiation failed: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        'Payment request failed. Please try again.',
      );
    }
  }

  // ─── CHECK PAYMENT STATUS ───────────────────────

  async checkPaymentStatus(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        pickup: {
          select: { reference: true, wasteType: true },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found.');
    }

    if (payment.userId !== userId) {
      throw new ForbiddenException('This payment does not belong to you.');
    }

    // If still pending, check with provider
    if (payment.status === PaymentStatus.PENDING && payment.externalRef) {
      try {
        let providerStatus: string;
        let failureReason: string | undefined;

        if (payment.method === PaymentMethod.MTN_MOMO) {
          const result = await this.momoService.checkPaymentStatus(
            payment.externalRef,
          );
          providerStatus = result.status;
          failureReason = result.reason;
        } else {
          const result = await this.airtelService.checkPaymentStatus(
            payment.externalRef,
          );
          providerStatus =
            result.status === 'SUCCESS' ? 'SUCCESSFUL' : result.status;
          failureReason = result.message;
        }

        // Update status based on provider response
        const isSuccessful = ['SUCCESSFUL', 'SUCCESS', 'TS'].includes(
          providerStatus.toUpperCase(),
        );
        const isFailed = ['FAILED', 'REJECTED', 'EXPIRED', 'TF'].includes(
          providerStatus.toUpperCase(),
        );

        if (isSuccessful) {
          await this.prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.COMPLETED,
              paidAt: new Date(),
            },
          });
          payment.status = PaymentStatus.COMPLETED;
        } else if (isFailed) {
          await this.prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.FAILED,
              failReason: failureReason,
              failedAt: new Date(),
            },
          });
          payment.status = PaymentStatus.FAILED;
          payment.failReason = failureReason ?? null;
        }
      } catch (error) {
        this.logger.error(`Status check failed: ${(error as Error).message}`);
        // Don't throw — just return current status
      }
    }

    return {
      success: true,
      data: {
        id: payment.id,
        transactionRef: payment.transactionRef,
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        status: payment.status,
        failReason: payment.failReason,
        paidAt: payment.paidAt,
        failedAt: payment.failedAt,
        pickup: payment.pickup,
      },
    };
  }

  // ─── GET PAYMENT HISTORY ────────────────────────

  async getPaymentHistory(userId?: string, query?: PaginationDto) {
    const where: Prisma.PaymentWhereInput = userId ? { userId } : {};
    const skip = query?.skip ?? 0;
    const limit = query?.limit ?? 50;

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take: limit,
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
          pickup: {
            select: {
              reference: true,
              wasteType: true,
              scheduledDate: true,
            },
          },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      success: true,
      data: payments.map((p) => ({
        id: p.id,
        transactionRef: p.transactionRef,
        amount: p.amount,
        currency: p.currency,
        method: p.method,
        status: p.status,
        paidAt: p.paidAt,
        user: p.user,
        pickup: p.pickup,
        createdAt: p.createdAt,
      })),
      meta: {
        page: query?.page ?? 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─── WEBHOOK CALLBACK (MoMo/Airtel) ─────────────

  async handleWebhook(provider: string, body: WebhookBody) {
    this.logger.log(
      `Payment webhook received from ${provider}: ${JSON.stringify(body)}`,
    );

    let transactionRef: string | undefined;
    let status: string;
    let reason: string | undefined;

    if (provider === 'momo') {
      // MTN MoMo callback
      transactionRef = body.externalId;
      status = body.status || 'PENDING'; // SUCCESSFUL or FAILED
      reason = body.reason;
    } else if (provider === 'airtel') {
      // Airtel callback
      transactionRef = body.transaction?.id;
      const airtelStatus =
        body.transaction?.status_code ||
        (body.transaction as { status?: string } | undefined)?.status ||
        '';
      status = airtelStatus === 'TS' ? 'SUCCESSFUL' : 'FAILED';
      reason = body.transaction?.message;
    } else {
      this.logger.warn(`Unknown payment provider: ${provider}`);
      return { received: true };
    }

    if (!transactionRef) {
      await this.prisma.paymentWebhookLog.create({
        data: {
          provider:
            provider === 'airtel'
              ? PaymentMethod.AIRTEL_MONEY
              : PaymentMethod.MTN_MOMO,
          payload: body as Prisma.InputJsonValue,
        },
      });
      this.logger.warn('Webhook received without transaction reference');
      return { received: true };
    }

    // Find and update payment
    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [{ transactionRef }, { externalRef: transactionRef }],
      },
    });

    if (!payment) {
      await this.prisma.paymentWebhookLog.create({
        data: {
          provider:
            provider === 'airtel'
              ? PaymentMethod.AIRTEL_MONEY
              : PaymentMethod.MTN_MOMO,
          transactionRef,
          payload: body as Prisma.InputJsonValue,
        },
      });
      this.logger.warn(`Payment not found for ref: ${transactionRef}`);
      return { received: true };
    }

    if (payment.status !== PaymentStatus.PENDING) {
      this.logger.log(
        `Payment ${transactionRef} already processed: ${payment.status}`,
      );
      return { received: true };
    }

    const isSuccessful = ['SUCCESSFUL', 'SUCCESS', 'TS'].includes(
      status.toUpperCase(),
    );
    const isFailed = ['FAILED', 'REJECTED', 'EXPIRED', 'TF'].includes(
      status.toUpperCase(),
    );

    if (!isSuccessful && !isFailed) {
      this.logger.log(
        `Payment ${transactionRef} status ${status} ignored (still pending).`,
      );
      return { received: true };
    }

    const newStatus = isSuccessful
      ? PaymentStatus.COMPLETED
      : PaymentStatus.FAILED;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: newStatus,
        paidAt: newStatus === PaymentStatus.COMPLETED ? new Date() : null,
        failedAt: newStatus === PaymentStatus.FAILED ? new Date() : null,
        failReason: newStatus === PaymentStatus.FAILED ? reason : null,
      },
    });

    await this.prisma.paymentWebhookLog.create({
      data: {
        paymentId: payment.id,
        provider: payment.method,
        transactionRef: payment.transactionRef,
        externalRef: payment.externalRef,
        status: newStatus,
        payload: body as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Payment ${transactionRef} updated to ${newStatus} via webhook`,
    );

    return { received: true, status: newStatus };
  }
}
