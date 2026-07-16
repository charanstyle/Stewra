import { createLogger, format, transports } from 'winston';
import { config } from '../config/unifiedConfig.js';

export const logger = createLogger({
  level: config.isProduction ? 'info' : 'debug',
  format: format.combine(format.timestamp(), format.errors({ stack: true }), format.json()),
  defaultMeta: { service: 'stewra-backend' },
  transports: [
    new transports.Console({
      format: config.isProduction
        ? format.json()
        : format.combine(format.colorize(), format.simple()),
    }),
  ],
});
