const { Command } = require('commander');
const logger = require('../utils/logger');
const wifiManager = require('../core/wifi-manager');
const hotspotAuth = require('../core/hotspot-auth');
const sessionStore = require('../core/session-store');
const cardRotator = require('../core/card-rotator');

const program = new Command();

program
  .name('mac-spoofer')
  .description('MikroTik MAC Spoofing & Card Rotation Tool')
  .version('1.0.0');

program
  .command('wifi-info')
  .description('Get current WiFi adapter information')
  .action(async () => {
    try {
      const info = await wifiManager.getAdapterInfo();
      console.log(JSON.stringify(info, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('spoof')
  .description('Spoof WiFi MAC address')
  .option('-m, --mac <mac>', 'Target MAC address (random if omitted)')
  .action(async (options) => {
    try {
      const mac = options.mac || wifiManager.generateRandomMac();
      console.log(`Spoofing MAC to: ${mac}`);
      const result = await wifiManager.spoofMac(mac);
      console.log(`MAC changed: ${result.oldMac} -> ${result.newMac}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('login')
  .description('Login to hotspot with card')
  .requiredOption('-u, --username <number>', 'Card number')
  .option('-d, --domain <speed>', 'Speed domain', '1024K/2048K')
  .action(async (options) => {
    try {
      const result = await hotspotAuth.login(options.username, options.domain);
      console.log(JSON.stringify(result, null, 2));
      if (!result.isSuccess) process.exit(1);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Logout from hotspot')
  .action(async () => {
    try {
      const result = await hotspotAuth.logout();
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check hotspot login status and quota')
  .action(async () => {
    try {
      const result = await hotspotAuth.getRemainingQuota();
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('cards')
  .description('List all cards')
  .action(() => {
    const cards = sessionStore.getCards();
    const stats = sessionStore.getStats();
    console.log(JSON.stringify({ cards, stats }, null, 2));
  });

program
  .command('add-card')
  .description('Add a card to the pool')
  .requiredOption('-n, --number <number>', 'Card number')
  .option('-d, --domain <speed>', 'Speed domain', '1024K/2048K')
  .option('-p, --profile <name>', 'Profile name', 'متوسطة')
  .action(async (options) => {
    try {
      const result = sessionStore.addCard({
        number: options.number,
        domain: options.domain,
        profile: options.profile,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('rotate')
  .description('Start automatic card rotation')
  .action(async () => {
    try {
      const result = await cardRotator.start();
      console.log(JSON.stringify(result, null, 2));
      if (result.isSuccess) {
        console.log('Rotation running. Press Ctrl+C to stop.');
        process.on('SIGINT', () => {
          cardRotator.stop();
          process.exit(0);
        });
        await new Promise(() => {});
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop card rotation')
  .action(() => {
    const result = cardRotator.stop();
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('state')
  .description('Show current rotation state')
  .action(() => {
    const state = cardRotator.getState();
    console.log(JSON.stringify(state, null, 2));
  });

if (require.main === module) {
  program.parse(process.argv);
  if (process.argv.length <= 2) {
    program.outputHelp();
  }
}

module.exports = { program };
