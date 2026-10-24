import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json as expressJson } from 'express';
import { AppModule } from './app.module.js';
import { config, requireConfig } from './config.js';
import { Errors } from './controllers.js';
import { accessScope } from './scope.js';
import { migrateLegacyFiles } from './storage.js';
import { Database } from './database.js';
requireConfig();
const app = await NestFactory.create(AppModule, { bodyParser: false });
app.use((req: any, res: any, next: () => void) => accessScope.run({}, next));
app.use((req: any, res: any, next: () => void) =>
  expressJson({ limit: /\/workspaces\/restore$/.test(req.path) ? '70mb' : '2mb' })(req, res, next),
);
app.use(cookieParser());
app.useGlobalFilters(new Errors());
app.enableCors({
  origin: config.appUrl,
  credentials: true,
  allowedHeaders: ['Content-Type', 'X-Forge-Request', 'Last-Event-ID'],
});
app.enableShutdownHooks();
const document = SwaggerModule.createDocument(
  app,
  new DocumentBuilder()
    .setTitle('Neural Forge local automation')
    .setVersion('1')
    .addCookieAuth('forge_session')
    .build(),
);
await migrateLegacyFiles(app.get(Database));
SwaggerModule.setup('api/docs', app, document);
await app.listen(config.port, config.bindAddress);
console.log(`API ready on http://127.0.0.1:${config.port}`);
