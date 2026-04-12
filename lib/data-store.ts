import fs from 'fs';
import path from 'path';
import { ReportData } from './types';

const DATA_PATH = path.join(process.cwd(), 'data', 'data.json');

export function readData(): ReportData {
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  return JSON.parse(raw);
}

export function writeData(data: ReportData): void {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
