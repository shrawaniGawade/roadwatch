import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded, Response } from 'express';
import { AppModule } from './app.module';

@Catch()
class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res.status(exception.getStatus()).json(typeof body === 'string' ? { message: body } : body);
      return;
    }
    if (exception?.code === '23505') {
      res
        .status(409)
        .json({ message: 'A record with this identity already exists.', code: 'duplicate_record' });
      return;
    }
    if (exception?.code === '23503') {
      res
        .status(400)
        .json({ message: 'A referenced record is unavailable.', code: 'invalid_reference' });
      return;
    }
    console.error('Unhandled API error:', exception?.message || 'Unknown error');
    res
      .status(500)
      .json({ message: 'The request could not be completed.', code: 'internal_error' });
  }
}
export async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(helmet());
  app.use(cookieParser());
  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: false, limit: '32kb' }));
  app.enableCors({
    origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
      .split(',')
      .map((s) => s.trim()),
    credentials: true,
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.PORT || process.env.API_PORT || 3001),
    process.env.API_HOST || '127.0.0.1',
  );
  return app;
}
if (require.main === module)
  void bootstrap().catch((err) => {
    console.error('API startup failed:', err.message);
    process.exitCode = 1;
  });
