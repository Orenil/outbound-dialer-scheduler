import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * This project's deliverable is the scheduling/pacing engine itself (see
 * `src/demo.ts` for a runnable end-to-end demo with real output, and
 * `test/` for the correctness/compliance suite). This entrypoint boots the
 * Nest application context so `@nestjs/schedule`'s interval-driven
 * PacingService is live, which is what a real deployment would run
 * alongside an API layer (omitted here as out of scope for the exercise).
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  Logger.log('outbound-dialer-scheduler application context started', 'Bootstrap');
  await app.init();
}

bootstrap();
