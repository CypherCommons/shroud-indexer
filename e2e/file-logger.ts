import { LoggerService } from '@nestjs/common';
import { createWriteStream, existsSync, mkdirSync, WriteStream } from 'fs';
import { join } from 'path';

export class FileLogger implements LoggerService {
    private logFolderPath = join(__dirname, '.logs');
    private logFilePath: string;
    private logFileStream: WriteStream;

    constructor(logFile: string) {
        if (!existsSync(this.logFolderPath)) {
            mkdirSync(this.logFolderPath, { recursive: true });
        }

        this.logFilePath = join(this.logFolderPath, `${logFile}.log`);
        this.logFileStream = createWriteStream(this.logFilePath, {
            flags: 'a',
        });
    }

    private writeLog(level: string, message: string, trace?: string) {
        const timestamp = new Date().toISOString();
        let logEntry = `[${timestamp}] [${level}] ${message}\n`;

        if (trace) {
            logEntry += `Trace: ${trace}\n`;
        }

        this.logFileStream.write(logEntry);
    }

    log(message: string) {
        this.writeLog('LOG', message);
    }

    error(message: string, trace: string) {
        this.writeLog('ERROR', message, trace);
    }

    warn(message: string) {
        this.writeLog('WARN', message);
    }

    debug(message: string) {
        this.writeLog('DEBUG', message);
    }

    verbose(message: string) {
        this.writeLog('VERBOSE', message);
    }

    getWriteStream() {
        return this.logFileStream;
    }
}
