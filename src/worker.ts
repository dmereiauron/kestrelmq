import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './modules/worker/worker.module.js';

const logger = new Logger('WorkerBootstrap');

async function bootstrapWorker(): Promise<void> {
  const appContext = await NestFactory.createApplicationContext(WorkerModule);
  appContext.enableShutdownHooks();

  let isShuttingDown = false;

  const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    logger.log(`Received ${signal}. Draining active BullMQ delivery jobs before exit...`);
    try {
      await appContext.close();
      logger.log('Worker application context closed cleanly.');
      process.exit(0);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'Unknown shutdown failure';
      logger.error(`Error while shutting down worker context: ${reason}`);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });

  process.once('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });

  logger.log('KestrelMQ background delivery worker started (no HTTP listener).');
}

void bootstrapWorker();
