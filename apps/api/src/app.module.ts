import { Global, Module } from '@nestjs/common';
import { Database } from './database';
import { AuthService, SessionGuard } from './security';
import { AssetsService } from './assets.service';
import { FindingsService } from './findings.service';
import { MediaService } from './media.service';
import { UsersService } from './users.service';
import {
  AssetsController,
  AuthController,
  FindingsController,
  HealthController,
  MediaController,
  ReportsController,
  UsersController,
} from './controllers';

@Global()
@Module({
  providers: [Database, AuthService, SessionGuard],
  exports: [Database, AuthService, SessionGuard],
})
class CoreModule {}
@Module({ controllers: [AuthController, HealthController] })
class IdentityModule {}
@Module({ providers: [AssetsService], controllers: [AssetsController], exports: [AssetsService] })
class AssetsModule {}
@Module({
  imports: [AssetsModule],
  providers: [FindingsService],
  controllers: [FindingsController],
})
class MaintenanceModule {}
@Module({ imports: [AssetsModule], providers: [MediaService], controllers: [MediaController] })
class IngestionModule {}
@Module({ imports: [AssetsModule], controllers: [ReportsController] })
class ReportsModule {}
@Module({ providers: [UsersService], controllers: [UsersController] })
class UsersModule {}
@Module({
  imports: [
    CoreModule,
    IdentityModule,
    AssetsModule,
    MaintenanceModule,
    IngestionModule,
    ReportsModule,
    UsersModule,
  ],
})
export class AppModule {}
