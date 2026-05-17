import pino from 'pino';
import { env, isProd } from '../config.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'rishtaai-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }),
});

export type Logger = typeof logger;
