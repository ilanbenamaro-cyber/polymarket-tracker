module.exports = {
  apps: [
    {
      name: 'polymarket-tracker',
      script: './tracker.js',
      interpreter: 'node',
      cron_restart: '0 14 * * *', // 9:00 AM ET = 14:00 UTC (summer / EDT)
      watch: false,
      autorestart: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/tmp/polymarket-tracker.log',
      error_file: '/tmp/polymarket-tracker-error.log',
    },
  ],
};
