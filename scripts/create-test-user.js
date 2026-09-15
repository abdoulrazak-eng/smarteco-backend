const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config();

function generateBinQrCode(userPrefix) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `BIN-${userPrefix}-${code}`;
}

async function seedUser(prisma, phone, email, firstName, lastName) {
  console.log(`\n--- Setting up Test Residential User: ${phone} ---`);
  let user = await prisma.user.findUnique({ where: { phone } });

  if (!user) {
    const referralCode = 'TESTER' + Math.random().toString(36).substring(2, 7).toUpperCase();
    user = await prisma.user.create({
      data: {
        phone,
        email,
        firstName,
        lastName,
        role: 'USER',
        userType: 'RESIDENTIAL',
        referralCode,
        isActive: true,
        defaultAddress: 'KN 3 Ave, Kigali, Rwanda',
        homeLatitude: -1.9441,
        homeLongitude: 30.0619,
      },
    });
    console.log(`Created user: ${user.id} (${user.phone})`);

    // EcoPoints bonus
    await prisma.ecoPointTransaction.create({
      data: {
        userId: user.id,
        points: 500,
        action: 'REGISTRATION',
        description: 'Welcome bonus: 500 EcoPoints',
      },
    });
    console.log(`Added 500 EcoPoints.`);
  } else {
    console.log(`User already exists: ${user.id} (${user.phone})`);
  }

  // Ensure bins exist
  const binsCount = await prisma.bin.count({ where: { userId: user.id } });
  if (binsCount === 0) {
    const userPrefix = user.id.substring(0, 3).toUpperCase();
    const binTypes = ['ORGANIC', 'RECYCLABLE', 'EWASTE', 'GENERAL', 'GLASS', 'HAZARDOUS'];
    const binData = binTypes.map((wasteType) => ({
      userId: user.id,
      wasteType,
      qrCode: generateBinQrCode(userPrefix),
      status: 'ACTIVE',
    }));
    await prisma.bin.createMany({ data: binData });
    console.log(`Default bins created.`);
  }

  return user;
}

async function seedCollector(prisma, phone, email, firstName, lastName) {
  console.log(`\n--- Setting up Test Collector User: ${phone} ---`);
  let user = await prisma.user.findUnique({
    where: { phone },
    include: { collectorProfile: true },
  });

  if (!user) {
    const referralCode = 'COLL' + Math.random().toString(36).substring(2, 7).toUpperCase();
    user = await prisma.user.create({
      data: {
        phone,
        email,
        firstName,
        lastName,
        role: 'COLLECTOR',
        userType: 'COLLECTOR',
        referralCode,
        isActive: true,
        defaultAddress: 'KG 7 Ave, Kigali, Rwanda',
        homeLatitude: -1.9500,
        homeLongitude: 30.0600,
      },
    });
    console.log(`Created collector user: ${user.id}`);
  }

  // Check or create collector profile
  let profile = await prisma.collectorProfile.findUnique({
    where: { userId: user.id },
  });

  if (!profile) {
    profile = await prisma.collectorProfile.create({
      data: {
        userId: user.id,
        collectorName: `${firstName} ${lastName}`,
        vehiclePlate: 'RAD 789 X',
        zone: 'Kigali Central',
        rating: 4.9,
        totalPickups: 24,
        isAvailable: true,
        isApproved: true,
        approvedAt: new Date(),
        approvedBy: 'SYSTEM_ADMIN',
        latitude: -1.9500,
        longitude: 30.0600,
      },
    });
    console.log(`Created approved CollectorProfile for ${user.id}`);
  } else if (!profile.isApproved) {
    await prisma.collectorProfile.update({
      where: { id: profile.id },
      data: { isApproved: true, approvedAt: new Date() },
    });
    console.log(`Updated CollectorProfile to approved.`);
  }

  return user;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set in environment variables.');
    process.exit(1);
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const pool = new Pool({
    connectionString,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    // 1. Regular User demo account
    await seedUser(prisma, '+11234567890', 'appstore.user@smarteco.rw', 'Demo', 'Resident');

    // 2. Collector demo account (+19997654321 bypasses Twilio with OTP 123456)
    await seedCollector(prisma, '+19997654321', 'appstore.collector@smarteco.rw', 'Demo', 'Collector');

    console.log('\n=============================================');
    console.log('Test Accounts Successfully Seeded for App Review:');
    console.log('1. Residential User:');
    console.log('   Phone: +11234567890 (or +19991234567)');
    console.log('   OTP:   123456');
    console.log('2. Waste Collector:');
    console.log('   Phone: +19997654321');
    console.log('   OTP:   123456');
    console.log('=============================================\n');
  } catch (error) {
    console.error('Error creating test users:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
