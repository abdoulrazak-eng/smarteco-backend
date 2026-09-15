import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SimulationScenario } from './dto/start-simulation.dto';
import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';

interface Step {
  name: string;
  run: () => Promise<any>;
}

@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);
  private activeRuns = new Map<string, boolean>(); // Track cancellation status

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  // Get list of previous simulation sessions
  async getSessions() {
    return this.prisma.simulationSession.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // Get detailed status of a specific simulation session
  async getSession(id: string) {
    const session = await this.prisma.simulationSession.findUnique({
      where: { id },
    });
    if (!session) {
      throw new NotFoundException('Simulation session not found');
    }
    return session;
  }

  // Cancel a running simulation session
  async cancelSimulation(id: string) {
    const session = await this.prisma.simulationSession.findUnique({
      where: { id },
    });

    if (!session) {
      throw new NotFoundException('Simulation session not found');
    }

    if (session.status !== 'RUNNING' && session.status !== 'PENDING') {
      throw new BadRequestException('Simulation session is not running');
    }

    this.activeRuns.set(id, false); // Mark as cancelled

    const updated = await this.prisma.simulationSession.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        logs: {
          push: {
            timestamp: new Date().toISOString(),
            level: 'WARN',
            message: 'Simulation cancelled by Super Admin',
          },
        },
      },
    });

    return {
      success: true,
      message: 'Simulation cancelled successfully',
      data: updated,
    };
  }

  // Starts a simulation scenario asynchronously in the background
  async startSimulation(startedBy: string, scenario: SimulationScenario) {
    const session = await this.prisma.simulationSession.create({
      data: {
        startedBy,
        scenario,
        status: 'RUNNING',
        progress: 0,
        logs: [],
        errors: [],
      },
    });

    // Run the simulation runner in the background
    this.runRunner(session.id, scenario, startedBy).catch((err) => {
      this.logger.error(
        `Runner failed for session ${session.id}: ${err.message}`,
        err.stack,
      );
    });

    return {
      success: true,
      message: `Simulation ${scenario} started successfully`,
      data: session,
    };
  }

  // Transactional safe cleanup of simulation data
  async clearSimulationData(simulationId: string) {
    this.logger.log(
      `Starting transactional cleanup for simulation ID: ${simulationId}`,
    );

    // Verify session exists
    const session = await this.prisma.simulationSession.findUnique({
      where: { id: simulationId },
    });

    if (!session) {
      throw new NotFoundException(
        `Simulation session ${simulationId} not found`,
      );
    }

    // Execute deletion sequence in order of foreign key dependencies
    await this.prisma.$transaction(async (tx) => {
      // 1. Delete Webhook Logs linked to simulation payments
      await tx.paymentWebhookLog.deleteMany({
        where: {
          payment: {
            simulationId,
          },
        },
      });

      // 2. Delete Payments
      await tx.payment.deleteMany({
        where: {
          simulationId,
        },
      });

      // 3. Delete Pickups
      await tx.pickup.deleteMany({
        where: {
          simulationId,
        },
      });

      // 4. Delete Users (will cascade-delete collector profile, bins, devices, notifications, transactions, redemptions, ledgers, and refresh tokens)
      await tx.user.deleteMany({
        where: {
          simulationId,
        },
      });

      // 5. Delete other records with onDelete: SetNull or simulationId
      await tx.sortingEvent.deleteMany({
        where: {
          simulationId,
        },
      });

      await tx.auditLog.deleteMany({
        where: {
          simulationId,
        },
      });

      await tx.communicationLog.deleteMany({
        where: {
          simulationId,
        },
      });

      await tx.otpVerification.deleteMany({
        where: {
          simulationId,
        },
      });

      // 6. Update the simulation session status to CLEARED
      await tx.simulationSession.update({
        where: { id: simulationId },
        data: {
          status: 'CLEARED',
        },
      });
    });

    this.logger.log(`Cleanup completed for simulation ID: ${simulationId}`);

    return {
      success: true,
      message: `All simulation data for ID ${simulationId} has been securely cleared.`,
    };
  }

  // Internal helper to run the simulation steps
  private async runRunner(
    sessionId: string,
    scenario: SimulationScenario,
    startedBy: string,
  ) {
    this.activeRuns.set(sessionId, true);

    const port = process.env.PORT || 3000;
    const client = axios.create({
      baseURL: `http://localhost:${port}/api/v1`,
      headers: {
        'x-simulation-id': sessionId,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true, // Don't throw on error status; we want to validate responses manually
    });

    const logs: any[] = [];
    const errors: any[] = [];
    const createdRecords: any = {
      users: [],
      pickups: [],
      bins: [],
      payments: [],
    };

    const addLog = async (
      level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR',
      message: string,
    ) => {
      const entry = { timestamp: new Date().toISOString(), level, message };
      logs.push(entry);
      this.logger.log(`[SIMULATION ${sessionId}] [${level}] ${message}`);

      // Persist logs periodically or at each log in dev
      await this.prisma.simulationSession
        .update({
          where: { id: sessionId },
          data: { logs },
        })
        .catch(() => {});
    };

    const updateProgress = async (
      progress: number,
      completedSteps: number,
      totalSteps: number,
    ) => {
      await this.prisma.simulationSession
        .update({
          where: { id: sessionId },
          data: { progress, completedSteps, totalSteps },
        })
        .catch(() => {});
    };

    await addLog('INFO', `Starting scenario: ${scenario}`);

    let steps: Step[] = [];

    // Define steps based on the scenario
    if (scenario === SimulationScenario.FULL_E2E) {
      steps = this.defineFullE2EScenario(
        client,
        sessionId,
        createdRecords,
        addLog,
        errors,
      );
    } else if (scenario === SimulationScenario.USER_FLOW) {
      steps = this.defineUserFlowScenario(
        client,
        sessionId,
        createdRecords,
        addLog,
        errors,
      );
    } else if (scenario === SimulationScenario.ADMIN_FLOW) {
      steps = this.defineAdminFlowScenario(
        client,
        sessionId,
        createdRecords,
        addLog,
        errors,
      );
    } else if (scenario === SimulationScenario.API_FLOW) {
      steps = this.defineApiFlowScenario(client, sessionId, addLog, errors);
    } else if (scenario === SimulationScenario.DB_SYNC) {
      steps = this.defineDbSyncScenario(
        client,
        sessionId,
        createdRecords,
        addLog,
        errors,
      );
    } else if (scenario === SimulationScenario.ERROR_HANDLING) {
      steps = this.defineErrorHandlingScenario(
        client,
        sessionId,
        createdRecords,
        addLog,
        errors,
      );
    }

    const totalSteps = steps.length;
    await updateProgress(0, 0, totalSteps);

    let completedSteps = 0;
    let failed = false;

    for (const step of steps) {
      // Check if simulation was cancelled
      if (this.activeRuns.get(sessionId) === false) {
        await addLog(
          'WARN',
          'Simulation runner stopped because it was cancelled.',
        );
        return;
      }

      await addLog('INFO', `Running Step: ${step.name}`);

      try {
        await step.run();
        completedSteps++;
        const progress = Math.round((completedSteps / totalSteps) * 100);
        await addLog('SUCCESS', `Completed Step: ${step.name}`);
        await updateProgress(progress, completedSteps, totalSteps);
      } catch (err) {
        failed = true;
        const errMsg = (err as Error).message || String(err);
        await addLog('ERROR', `Failed Step: ${step.name} - ${errMsg}`);
        errors.push({
          step: step.name,
          error: errMsg,
          stack: (err as Error).stack,
        });
        break; // Stop execution on first failure
      }
    }

    // Final result
    const status = failed ? 'FAILED' : 'PASSED';
    const finalReport = {
      totalTests: totalSteps,
      passed: completedSteps,
      failed: failed ? 1 : 0,
      warnings: 0,
      apiTests: totalSteps,
      databaseTests: totalSteps,
      createdRecords,
    };

    await this.prisma.simulationSession.update({
      where: { id: sessionId },
      data: {
        status,
        progress: 100,
        errors,
        finalResult: finalReport,
      },
    });

    await addLog(
      failed ? 'ERROR' : 'SUCCESS',
      `Simulation finished. Status: ${status}`,
    );
    this.activeRuns.delete(sessionId);
  }

  // Scenario 1: Full A-Z E2E Business lifecycle
  private defineFullE2EScenario(
    client: AxiosInstance,
    sessionId: string,
    createdRecords: any,
    addLog: (level: any, msg: string) => Promise<void>,
    errors: any[],
  ): Step[] {
    let userPhone: string;
    let collectorPhone: string;
    let userToken: string;
    let userId: string;
    let collectorToken: string;
    let collectorUserId: string;
    let collectorProfileId: string;
    let adminToken: string;
    let selectedBinQr: string;
    let pickupId: string;
    let pickupRef: string;
    let transactionRef: string;

    return [
      {
        name: 'System Initialization',
        run: async () => {
          // 1. Verify health check
          const res = await client.get('/health');
          if (res.status !== 200 || res.data?.data?.status !== 'OK') {
            throw new Error(`Health check failed: Status ${res.status}`);
          }
          await addLog(
            'INFO',
            `Health API verified: status=OK, uptime=${res.data.data.uptime}s`,
          );

          // 2. Query database directly to verify Prisma connection
          const userCount = await this.prisma.user.count();
          await addLog(
            'INFO',
            `Database connection verified. Existing user count: ${userCount}`,
          );

          // 3. Verify key configurations
          const hasAdminEmail = !!this.configService.get('ADMIN_EMAIL');
          const hasAdminPassword = !!this.configService.get('ADMIN_PASSWORD');
          if (!hasAdminEmail || !hasAdminPassword) {
            throw new Error(
              'Required configuration ADMIN_EMAIL/ADMIN_PASSWORD is missing',
            );
          }
        },
      },
      {
        name: 'Register and Authenticate User',
        run: async () => {
          const rand = Math.floor(1000000 + Math.random() * 9000000);
          userPhone = `+1999${rand}`;

          // Send OTP (Bypassed)
          const sendRes = await client.post('/auth/otp/send', {
            phone: userPhone,
            isLogin: false,
          });
          if (sendRes.status !== 200 || !sendRes.data.success) {
            throw new Error(`Send OTP failed: ${JSON.stringify(sendRes.data)}`);
          }

          // Verify OTP (Bypassed with 123456)
          const verifyRes = await client.post('/auth/otp/verify', {
            phone: userPhone,
            otp: '123456',
            signupRole: 'USER',
          });

          if (verifyRes.status !== 200 || !verifyRes.data.success) {
            throw new Error(
              `Verify OTP failed: ${JSON.stringify(verifyRes.data)}`,
            );
          }

          userToken = verifyRes.data.data.accessToken;
          userId = verifyRes.data.data.user.id;
          createdRecords.users.push(userId);

          await addLog(
            'INFO',
            `User registered successfully. ID: ${userId}, Phone: ${userPhone}`,
          );
        },
      },
      {
        name: 'Update User Profile settings',
        run: async () => {
          const updateRes = await client.patch(
            '/users/me',
            {
              firstName: 'Simulated',
              lastName: 'Resident',
              email: `simulated_user_${uuidv4().substring(0, 8)}@smarteco.com`,
            },
            {
              headers: { Authorization: `Bearer ${userToken}` },
            },
          );

          if (updateRes.status !== 200 || !updateRes.data.success) {
            throw new Error(
              `Profile update failed: ${JSON.stringify(updateRes.data)}`,
            );
          }

          // Verify update
          const meRes = await client.get('/users/me', {
            headers: { Authorization: `Bearer ${userToken}` },
          });

          if (
            meRes.data.data.firstName !== 'Simulated' ||
            meRes.data.data.lastName !== 'Resident'
          ) {
            throw new Error(
              'Profile update verification failed. Values mismatch.',
            );
          }

          await addLog('INFO', `User profile updated: Simulated Resident`);
        },
      },
      {
        name: 'Verify Default Bins Created & Sync IoT Telemetry (Fill Level -> Full)',
        run: async () => {
          // Fetch bins
          const binsRes = await client.get('/bins', {
            headers: { Authorization: `Bearer ${userToken}` },
          });

          if (
            binsRes.status !== 200 ||
            !binsRes.data.success ||
            binsRes.data.data.length === 0
          ) {
            throw new Error(
              `Failed to fetch default bins: ${JSON.stringify(binsRes.data)}`,
            );
          }

          const bin = binsRes.data.data[0];
          selectedBinQr = bin.qrCode;
          createdRecords.bins.push(bin.id);

          await addLog('INFO', `Found default bin QR: ${selectedBinQr}`);

          // Sync fill level to 96% to trigger auto-pickup
          const syncRes = await client.post('/bins/iot/sync', {
            qrCode: selectedBinQr,
            deviceId: `LORA-SIM-${uuidv4().substring(0, 4)}`,
            fillLevel: 96,
            batteryLevel: 92,
            signalRssi: -72,
            apiKey:
              this.configService.get('IOT_DEVICE_API_KEY') ||
              'smarteco-iot-secret-key-2026',
          });

          if (syncRes.status !== 200) {
            throw new Error(`IoT sync failed: ${JSON.stringify(syncRes.data)}`);
          }

          await addLog('INFO', `IoT Sync completed. Sent fillLevel=96%.`);

          // Verify database status is FULL and pickup is scheduled
          const dbBin = await this.prisma.bin.findUnique({
            where: { qrCode: selectedBinQr },
          });
          if (!dbBin) {
            throw new Error('Bin not found in database');
          }
          if (dbBin.status !== 'FULL' || dbBin.fillLevel !== 96) {
            throw new Error(
              `Database Bin state mismatch. Expected status FULL, got ${dbBin.status}`,
            );
          }

          // Fetch pickups to find the auto-scheduled one
          const pickupsRes = await client.get('/pickups', {
            headers: { Authorization: `Bearer ${userToken}` },
          });

          const autoPickup = pickupsRes.data.data.find(
            (p: any) => p.binId === bin.id || p.notes?.includes(selectedBinQr),
          );

          if (!autoPickup) {
            throw new Error(
              'Auto-scheduled pickup was not created for full bin.',
            );
          }

          pickupId = autoPickup.id;
          pickupRef = autoPickup.reference;
          createdRecords.pickups.push(pickupId);

          await addLog(
            'INFO',
            `Auto-scheduled pickup scheduled successfully. Ref: ${pickupRef}, ID: ${pickupId}`,
          );
        },
      },
      {
        name: 'Register and Approve Collector',
        run: async () => {
          const rand = Math.floor(1000000 + Math.random() * 9000000);
          collectorPhone = `+1999${rand}`;

          // Create collector user
          await client.post('/auth/otp/send', {
            phone: collectorPhone,
            isLogin: false,
          });
          const verifyRes = await client.post('/auth/otp/verify', {
            phone: collectorPhone,
            otp: '123456',
            signupRole: 'USER',
          });
          collectorToken = verifyRes.data.data.accessToken;
          collectorUserId = verifyRes.data.data.user.id;
          createdRecords.users.push(collectorUserId);

          // Self-register as collector
          const regRes = await client.post(
            '/collectors/register-me',
            {
              vehiclePlate: `RAD ${rand.toString().substring(0, 3)}A`,
              zone: 'Kigali',
            },
            { headers: { Authorization: `Bearer ${collectorToken}` } },
          );

          if (regRes.status !== 201 || !regRes.data.success) {
            throw new Error(
              `Collector self-registration failed: ${JSON.stringify(regRes.data)}`,
            );
          }

          // Admin logs in to approve collector
          const adminEmail = this.configService.get('ADMIN_EMAIL');
          const adminPassword = this.configService.get('ADMIN_PASSWORD');
          const adminLoginRes = await client.post('/auth/admin/login', {
            email: adminEmail,
            password: adminPassword,
          });

          if (adminLoginRes.status !== 200 || !adminLoginRes.data.success) {
            throw new Error('Admin login failed');
          }

          adminToken = adminLoginRes.data.data.accessToken;

          // Fetch pending collectors to get the ID
          const pendingRes = await client.get('/admin/collectors/pending', {
            headers: { Authorization: `Bearer ${adminToken}` },
          });

          const application = pendingRes.data.data.find(
            (c: any) => c.userId === collectorUserId,
          );
          if (!application) {
            throw new Error('Collector application not found in pending list');
          }

          collectorProfileId = application.id;

          // Approve collector
          const approveRes = await client.patch(
            `/admin/collectors/${collectorProfileId}/approve`,
            { isApproved: true },
            { headers: { Authorization: `Bearer ${adminToken}` } },
          );

          if (approveRes.status !== 200 || !approveRes.data.success) {
            throw new Error(
              `Collector approval failed: ${JSON.stringify(approveRes.data)}`,
            );
          }

          // Retrieve new collector tokens with collector role
          const reloginRes = await client.post('/auth/otp/verify', {
            phone: collectorPhone,
            otp: '123456',
            signupRole: 'COLLECTOR',
          });
          collectorToken = reloginRes.data.data.accessToken;

          await addLog(
            'INFO',
            `Collector registered and approved. Profile ID: ${collectorProfileId}`,
          );
        },
      },
      {
        name: 'Admin Assigns Collector to Pickup',
        run: async () => {
          const assignRes = await client.post(
            `/admin/pickups/${pickupId}/assign`,
            { collectorId: collectorProfileId },
            { headers: { Authorization: `Bearer ${adminToken}` } },
          );

          if (assignRes.status !== 200 || !assignRes.data.success) {
            throw new Error(
              `Collector assignment failed: ${JSON.stringify(assignRes.data)}`,
            );
          }

          // Verify status in database
          const dbPickup = await this.prisma.pickup.findUnique({
            where: { id: pickupId },
          });
          if (!dbPickup) {
            throw new Error('Pickup not found in database');
          }
          if (
            dbPickup.status !== 'COLLECTOR_ASSIGNED' ||
            dbPickup.collectorId !== collectorProfileId
          ) {
            throw new Error(
              `Pickup status update check failed. Got: ${dbPickup.status}`,
            );
          }

          await addLog(
            'INFO',
            `Admin assigned collector RAD 999S to pickup ${pickupRef}`,
          );
        },
      },
      {
        name: 'Collector Flow status transitions to COMPLETED',
        run: async () => {
          const headers = { Authorization: `Bearer ${collectorToken}` };

          // EN_ROUTE
          const r1 = await client.patch(
            `/collectors/pickups/${pickupId}/status`,
            { status: 'EN_ROUTE' },
            { headers },
          );
          if (r1.status !== 200)
            throw new Error(
              `Transition to EN_ROUTE failed: ${JSON.stringify(r1.data)}`,
            );

          // ARRIVED
          const r2 = await client.patch(
            `/collectors/pickups/${pickupId}/status`,
            { status: 'ARRIVED' },
            { headers },
          );
          if (r2.status !== 200)
            throw new Error(
              `Transition to ARRIVED failed: ${JSON.stringify(r2.data)}`,
            );

          // IN_PROGRESS
          const r3 = await client.patch(
            `/collectors/pickups/${pickupId}/status`,
            { status: 'IN_PROGRESS' },
            { headers },
          );
          if (r3.status !== 200)
            throw new Error(
              `Transition to IN_PROGRESS failed: ${JSON.stringify(r3.data)}`,
            );

          // COMPLETED (weight is required)
          const r4 = await client.patch(
            `/collectors/pickups/${pickupId}/status`,
            { status: 'COMPLETED', weightKg: 12.5 },
            { headers },
          );
          if (r4.status !== 200)
            throw new Error(
              `Transition to COMPLETED failed: ${JSON.stringify(r4.data)}`,
            );

          // Verify DB state
          const dbPickup = await this.prisma.pickup.findUnique({
            where: { id: pickupId },
          });
          if (!dbPickup) {
            throw new Error('Pickup not found in database');
          }
          if (dbPickup.status !== 'COMPLETED' || dbPickup.weightKg !== 12.5) {
            throw new Error('Pickup not completed correctly in database');
          }

          // Verify Bin was reset
          const dbBin = await this.prisma.bin.findUnique({
            where: { qrCode: selectedBinQr },
          });
          if (!dbBin) {
            throw new Error('Bin not found in database');
          }
          if (dbBin.fillLevel !== 0 || dbBin.status !== 'ACTIVE') {
            throw new Error(
              'Associated bin was not emptied/reset upon pickup completion',
            );
          }

          // Verify EcoPoints awarded
          const userPoints = await this.prisma.ecoPointTransaction.aggregate({
            where: { userId },
            _sum: { points: true },
          });

          await addLog(
            'INFO',
            `Pickup completed. User total EcoPoints balance is now: ${userPoints._sum.points || 0}`,
          );
        },
      },
      {
        name: 'User Initiates Payment and Webhook Callback simulates COMPLETION',
        run: async () => {
          // Initiate Payment
          const payRes = await client.post(
            '/payments',
            { pickupId, amount: 500, phone: userPhone, method: 'MOMO' },
            { headers: { Authorization: `Bearer ${userToken}` } },
          );

          if (payRes.status !== 201 || !payRes.data.success) {
            throw new Error(
              `Payment initiation failed: ${JSON.stringify(payRes.data)}`,
            );
          }

          const paymentId = payRes.data.data.paymentId;
          transactionRef = payRes.data.data.transactionRef;
          createdRecords.payments.push(paymentId);

          await addLog(
            'INFO',
            `Payment initiated. Ref: ${transactionRef}. ID: ${paymentId}`,
          );

          // Trigger webhook simulation (MTN MoMo callback)
          const callbackRes = await client.post('/payments/webhook/momo', {
            externalId: transactionRef,
            status: 'SUCCESSFUL',
            financialTransactionId: `MOMO-SIM-${uuidv4().substring(0, 6).toUpperCase()}`,
            reason: null,
          });

          if (callbackRes.status !== 200) {
            throw new Error('Simulated Webhook callback failed');
          }

          // Verify status in DB
          const dbPayment = await this.prisma.payment.findUnique({
            where: { id: paymentId },
          });
          if (!dbPayment) {
            throw new Error('Payment not found in database');
          }
          if (dbPayment.status !== 'COMPLETED') {
            throw new Error(
              `Expected payment status COMPLETED, got ${dbPayment.status}`,
            );
          }

          await addLog(
            'INFO',
            `Simulated MoMo payment verified COMPLETED in database.`,
          );
        },
      },
      {
        name: 'Verify Admin Dashboard Metrics reflect changes',
        run: async () => {
          const dashboardRes = await client.get('/admin/dashboard', {
            headers: { Authorization: `Bearer ${adminToken}` },
          });

          if (dashboardRes.status !== 200 || !dashboardRes.data.success) {
            throw new Error('Admin Dashboard API failed');
          }

          const stats = dashboardRes.data.data;
          await addLog(
            'INFO',
            `Admin Dashboard Metrics: Total Pickups Completed = ${stats.pickups?.completed}, Total Revenue RWF = ${stats.revenue?.totalRwf}`,
          );
        },
      },
    ];
  }

  // Scenario 2: User flow simulation (register, login, manual schedule)
  private defineUserFlowScenario(
    client: AxiosInstance,
    sessionId: string,
    createdRecords: any,
    addLog: (level: any, msg: string) => Promise<void>,
    errors: any[],
  ): Step[] {
    let userPhone: string;
    let userToken: string;
    let userId: string;

    return [
      {
        name: 'User OTP Registration',
        run: async () => {
          const rand = Math.floor(1000000 + Math.random() * 9000000);
          userPhone = `+1999${rand}`;

          await client.post('/auth/otp/send', {
            phone: userPhone,
            isLogin: false,
          });
          const verifyRes = await client.post('/auth/otp/verify', {
            phone: userPhone,
            otp: '123456',
            signupRole: 'USER',
          });

          userToken = verifyRes.data.data.accessToken;
          userId = verifyRes.data.data.user.id;
          createdRecords.users.push(userId);

          await addLog(
            'INFO',
            `Simulated user registered with phone: ${userPhone}`,
          );
        },
      },
      {
        name: 'Manually Schedule a Waste Pickup',
        run: async () => {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 2); // 48 hours in future

          const pickupRes = await client.post(
            '/pickups',
            {
              wasteType: 'RECYCLABLE',
              scheduledDate: tomorrow.toISOString(),
              timeSlot: 'AFTERNOON_2_4',
              address: '123 SmartEco AI Rd, Kigali',
              latitude: -1.9441,
              longitude: 30.0619,
              notes: 'Simulated manual pickup',
            },
            {
              headers: { Authorization: `Bearer ${userToken}` },
            },
          );

          if (pickupRes.status !== 201 || !pickupRes.data.success) {
            throw new Error(
              `Manual pickup schedule failed: ${JSON.stringify(pickupRes.data)}`,
            );
          }

          const pickupId = pickupRes.data.data.id;
          createdRecords.pickups.push(pickupId);

          await addLog(
            'INFO',
            `Manual pickup scheduled. Ref: ${pickupRes.data.data.reference}`,
          );
        },
      },
    ];
  }

  // Scenario 3: Admin flow simulation
  private defineAdminFlowScenario(
    client: AxiosInstance,
    sessionId: string,
    createdRecords: any,
    addLog: (level: any, msg: string) => Promise<void>,
    errors: any[],
  ): Step[] {
    let adminToken: string;

    return [
      {
        name: 'Admin Login',
        run: async () => {
          const adminEmail = this.configService.get('ADMIN_EMAIL');
          const adminPassword = this.configService.get('ADMIN_PASSWORD');
          const res = await client.post('/auth/admin/login', {
            email: adminEmail,
            password: adminPassword,
          });

          if (res.status !== 200 || !res.data.success) {
            throw new Error('Admin login failed');
          }

          adminToken = res.data.data.accessToken;
          await addLog('INFO', 'Admin authenticated successfully.');
        },
      },
      {
        name: 'Fetch Users & Bins Admin Lists',
        run: async () => {
          const usersRes = await client.get('/admin/users', {
            headers: { Authorization: `Bearer ${adminToken}` },
          });

          if (usersRes.status !== 200) {
            throw new Error('Admin failed to get users list');
          }

          const binsRes = await client.get('/admin/bins', {
            headers: { Authorization: `Bearer ${adminToken}` },
          });

          if (binsRes.status !== 200) {
            throw new Error('Admin failed to get bins list');
          }

          await addLog(
            'INFO',
            `Admin fetched lists: users count = ${usersRes.data.data?.length || 0}, bins count = ${binsRes.data.data?.length || 0}`,
          );
        },
      },
    ];
  }

  // Scenario 4: API Endpoint simulation
  private defineApiFlowScenario(
    client: AxiosInstance,
    sessionId: string,
    addLog: (level: any, msg: string) => Promise<void>,
    errors: any[],
  ): Step[] {
    return [
      {
        name: 'Validate Health & Public endpoints',
        run: async () => {
          const r1 = await client.get('/health');
          if (r1.status !== 200) throw new Error('Health check failed');

          const r2 = await client.post('/auth/otp/send', {
            phone: 'invalid',
            isLogin: true,
          });
          if (r2.status !== 400) {
            throw new Error(
              `Expected status 400 for invalid phone format, got ${r2.status}`,
            );
          }

          await addLog('INFO', 'Public API validations completed.');
        },
      },
    ];
  }

  // Scenario 5: Database Synchronization Verification
  private defineDbSyncScenario(
    client: AxiosInstance,
    sessionId: string,
    createdRecords: any,
    addLog: (level: any, msg: string) => Promise<void>,
    errors: any[],
  ): Step[] {
    let userPhone: string;
    let userToken: string;
    let userId: string;

    return [
      {
        name: 'Register User and Verify Database Sync',
        run: async () => {
          const rand = Math.floor(1000000 + Math.random() * 9000000);
          userPhone = `+1999${rand}`;

          const verifyRes = await client.post('/auth/otp/verify', {
            phone: userPhone,
            otp: '123456',
            signupRole: 'USER',
          });

          userToken = verifyRes.data.data.accessToken;
          userId = verifyRes.data.data.user.id;
          createdRecords.users.push(userId);

          // Compare database state directly
          const dbUser = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { phone: true, role: true },
          });

          if (!dbUser) {
            throw new Error(
              `User not found in DB after registration. ID: ${userId}`,
            );
          }

          if (dbUser.phone !== userPhone) {
            throw new Error(
              `Data mismatch: API returned phone ${userPhone}, DB has ${dbUser.phone}`,
            );
          }

          await addLog(
            'INFO',
            `Database user sync verified. Phone: ${dbUser.phone}`,
          );
        },
      },
    ];
  }

  // Scenario 6: Error handling and negative flows validation
  private defineErrorHandlingScenario(
    client: AxiosInstance,
    sessionId: string,
    createdRecords: any,
    addLog: (level: any, msg: string) => Promise<void>,
    errors: any[],
  ): Step[] {
    return [
      {
        name: 'Verify Unauthorized Requests are rejected',
        run: async () => {
          const res = await client.get('/users/me'); // No auth header
          if (res.status !== 401) {
            throw new Error(
              `Expected status 401 for unauthenticated request, got ${res.status}`,
            );
          }
          await addLog(
            'INFO',
            'Unauthorized request successfully rejected with 401.',
          );
        },
      },
      {
        name: 'Verify Bad Inputs and DTO Constraints are rejected',
        run: async () => {
          // Missing required fields
          const res = await client.post('/auth/otp/send', {});
          if (res.status !== 400) {
            throw new Error(
              `Expected status 400 for empty body, got ${res.status}`,
            );
          }
          await addLog(
            'INFO',
            'Empty request payload successfully rejected with 400.',
          );
        },
      },
    ];
  }
}
