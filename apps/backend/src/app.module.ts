import {
  Accounts,
  AuthController,
  AccountController,
  AdminController,
  WorkspaceController,
  WorkspaceSettingsController,
} from './accounts.js';
import { Workspaces } from './workspaces.js';
import { Module } from '@nestjs/common';
import { Database } from './database.js';
import { LocalAI } from './ai.js';
import { Connections } from './connections.js';
import { ConnectionLifecycle } from './connection-lifecycle.js';
import { Operations } from './operations.js';
import { ExecutionEngine } from './engine.js';
import { Runtime } from './runtime.js';
import { Polling } from './polling.js';
import { AuthGuard, WorkspaceGuard, AdminGuard } from './auth.js';
import { BackupsController, WorkspaceBackups, WorkspaceRestoreController } from './backups.js';
import {
  CatalogController,
  ConnectionsController,
  LocalController,
  RunsController,
  SystemController,
  WebhookController,
  WorkflowsController,
  GoogleCallbackController,
  PublicCatalogController,
} from './controllers.js';
@Module({
  providers: [
    Workspaces,
    Accounts,
    WorkspaceBackups,
    AuthGuard,
    WorkspaceGuard,
    AdminGuard,
    Database,
    LocalAI,
    Connections,
    ConnectionLifecycle,
    Operations,
    ExecutionEngine,
    Runtime,
    Polling,
  ],
  controllers: [
    AuthController,
    AccountController,
    AdminController,
    WorkspaceController,
    WorkspaceSettingsController,
    GoogleCallbackController,
    PublicCatalogController,
    WorkspaceRestoreController,
    SystemController,
    WorkflowsController,
    RunsController,
    ConnectionsController,
    CatalogController,
    LocalController,
    WebhookController,
    BackupsController,
  ],
})
export class AppModule {}
