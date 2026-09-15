/**
 * SmartEco AI IoT Gateway & Sensor Simulator (Plan B)
 * 
 * Simulates real-time LoRaWAN gateway telemetry payloads over MQTT or HTTP REST
 * to test SmartBin fill-level monitoring, threshold triggers (80% alert, 90% auto-pickup),
 * battery levels, RSSI signal strength, and telemetry persistence without physical hardware.
 * 
 * Usage:
 *   node iot_gateway_simulator.js --mode=mqtt --broker=mqtt://localhost:1883 --interval=5000
 *   OR
 *   node iot_gateway_simulator.js --mode=http --api=http://localhost:3000/api/v1/bins/iot/sync --interval=3000
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Parse CLI flags
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    acc[key] = value || true;
    return acc;
}, {});

const MODE = args.mode || 'http'; // 'http' or 'mqtt'
const API_URL = args.api || 'http://localhost:3000/api/v1/bins/iot/sync';
const MQTT_BROKER = args.broker || 'mqtt://localhost:1883';
const INTERVAL_MS = parseInt(args.interval || '5000', 10);
const API_KEY = args.apiKey || 'smarteco-iot-secret-key-2026';

// Test Bins / Simulated Hardware Devices
const SIMULATED_BINS = [
    { qrCode: 'BIN-ORG-001', deviceId: 'LORA-DEV-8821', wasteType: 'ORGANIC', fillLevel: 45, lat: -1.9441, lng: 30.0619, battery: 95 },
    { qrCode: 'BIN-REC-002', deviceId: 'LORA-DEV-8822', wasteType: 'RECYCLABLE', fillLevel: 75, lat: -1.9501, lng: 30.0589, battery: 88 },
    { qrCode: 'BIN-EWA-003', deviceId: 'LORA-DEV-8823', wasteType: 'EWASTE', fillLevel: 88, lat: -1.9388, lng: 30.0712, battery: 91 },
    { qrCode: 'BIN-LAN-004', deviceId: 'LORA-DEV-8824', wasteType: 'GENERAL', fillLevel: 20, lat: -1.9620, lng: 30.0890, battery: 100 },
    { qrCode: 'BIN-HAZ-005', deviceId: 'LORA-DEV-8825', wasteType: 'HAZARDOUS', fillLevel: 94, lat: -1.9210, lng: 30.0450, battery: 82 },
];

console.log('====================================================');
console.log('🌿 SmartEco AI IoT Gateway & Telemetry Simulator (Plan B)');
console.log(`Mode: ${MODE.toUpperCase()}`);
console.log(`Target: ${MODE === 'http' ? API_URL : MQTT_BROKER}`);
console.log(`Update Interval: ${INTERVAL_MS} ms`);
console.log(`Simulating ${SIMULATED_BINS.length} LoRaWAN Smart Bin Sensors...`);
console.log('====================================================\n');

let mqttClient = null;

if (MODE === 'mqtt') {
    try {
        const mqtt = require('mqtt');
        mqttClient = mqtt.connect(MQTT_BROKER);
        mqttClient.on('connect', () => {
            console.log(`[MQTT] Connected successfully to broker at ${MQTT_BROKER}`);
            startSimulation();
        });
        mqttClient.on('error', (err) => {
            console.error(`[MQTT Error] ${err.message}`);
        });
    } catch (e) {
        console.error('[Error] MQTT library not installed. Run `npm install mqtt` or use `--mode=http`.');
        process.exit(1);
    }
} else {
    startSimulation();
}

function startSimulation() {
    setInterval(() => {
        // Pick a random simulated bin
        const bin = SIMULATED_BINS[Math.floor(Math.random() * SIMULATED_BINS.length)];

        // Simulate fill level changes (gradual fill or empty reset)
        if (bin.fillLevel >= 98) {
            bin.fillLevel = 10; // Emptying event simulated
            console.log(`\n♻️  [RESET] Bin ${bin.qrCode} emptied! Resetting fill level to 10%`);
        } else {
            const increment = Math.floor(Math.random() * 8) + 2; // Fill 2-10%
            bin.fillLevel = Math.min(100, bin.fillLevel + increment);
        }

        // Slight battery drain
        bin.battery = Math.max(10, bin.battery - (Math.random() > 0.8 ? 1 : 0));
        const rssi = -60 - Math.floor(Math.random() * 40); // -60 to -100 dBm

        const payload = {
            qrCode: bin.qrCode,
            deviceId: bin.deviceId,
            fillLevel: bin.fillLevel,
            batteryLevel: bin.battery,
            signalRssi: rssi,
            latitude: bin.lat + (Math.random() - 0.5) * 0.0005, // Slight GPS jitter
            longitude: bin.lng + (Math.random() - 0.5) * 0.0005,
            rawDistanceMm: Math.round(1200 - (bin.fillLevel / 100) * 1000), // Ultrasonic sensor raw mm reading
            apiKey: API_KEY,
            timestamp: new Date().toISOString()
        };

        if (MODE === 'http') {
            sendHttpPayload(payload);
        } else if (MODE === 'mqtt' && mqttClient) {
            sendMqttPayload(payload);
        }
    }, INTERVAL_MS);
}

function sendHttpPayload(payload) {
    const url = new URL(API_URL);
    const postData = JSON.stringify(payload);

    const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'X-API-KEY': API_KEY
        }
    };

    const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
        let responseBody = '';
        res.on('data', chunk => responseBody += chunk);
        res.on('end', () => {
            const alertTag = payload.fillLevel >= 90 ? '🚨 [AUTO-SCHEDULE]' : (payload.fillLevel >= 80 ? '⚠️  [ALERT]' : 'ℹ️  [OK]');
            console.log(`[HTTP ${res.statusCode}] Bin: ${payload.qrCode} | Fill: ${payload.fillLevel}% | Batt: ${payload.batteryLevel}% | ${alertTag}`);
        });
    });

    req.on('error', (e) => {
        console.error(`[HTTP Error] Failed to send payload for ${payload.qrCode}: ${e.message}`);
    });

    req.write(postData);
    req.end();
}

function sendMqttPayload(payload) {
    const topic = 'smarteco/iot/up';
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) {
            console.error(`[MQTT Pub Error] ${err.message}`);
        } else {
            const alertTag = payload.fillLevel >= 90 ? '🚨 [AUTO-SCHEDULE]' : (payload.fillLevel >= 80 ? '⚠️  [ALERT]' : 'ℹ️  [OK]');
            console.log(`[MQTT Pub -> ${topic}] Bin: ${payload.qrCode} | Fill: ${payload.fillLevel}% | Batt: ${payload.batteryLevel}% | ${alertTag}`);
        }
    });
}
