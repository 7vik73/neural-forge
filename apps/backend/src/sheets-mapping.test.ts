import { afterEach, expect, it, vi } from 'vitest';
import { google } from 'googleapis';
import { createNode } from '@forge/connectors';
import { Operations } from './operations.js';
import { accessScope } from './scope.js';

afterEach(() => vi.restoreAllMocks());

it('writes persisted object fields in the chosen spreadsheet column order', async () => {
  const append = vi.fn().mockResolvedValue({ data: { updates: { updatedCells: 6 } } });
  vi.spyOn(google, 'sheets').mockReturnValue({ spreadsheets: { values: { append } } } as any);
  const connections = { google: vi.fn().mockResolvedValue({}), assertApp: vi.fn() };
  const operations = new Operations({} as any, connections as any, {} as any);
  const node = createNode('sheets.append', 'ledger');
  node.config = {
    connectionId: 'workspace-google',
    spreadsheetId: 'fixture-sheet',
    range: 'Leads!A:C',
    columns: 'name,email,company',
  };
  const output = await accessScope.run({ workspaceId: 'workspace' }, () =>
    operations.execute(
      node,
      {
        rows: [
          { company: 'Example Co', email: 'buyer@example.com', name: 'Demo Buyer' },
          { name: 'Missing optional fields' },
        ],
      },
      {
        workspaceId: 'workspace',
        key: 'task',
        runId: 'run',
        preview: false,
        signal: new AbortController().signal,
        timezone: 'UTC',
        predecessors: [],
      },
    ),
  );
  expect(append.mock.calls[0]![0].requestBody.values).toEqual([
    ['Demo Buyer', 'buyer@example.com', 'Example Co'],
    ['Missing optional fields', '', ''],
  ]);
  expect(output).toEqual({ updated: 6 });
});

it('keeps existing array rows unchanged when column ordering is configured', async () => {
  const update = vi.fn().mockResolvedValue({ data: { updatedCells: 2 } });
  vi.spyOn(google, 'sheets').mockReturnValue({ spreadsheets: { values: { update } } } as any);
  const operations = new Operations(
    {} as any,
    { google: vi.fn(), assertApp: vi.fn() } as any,
    {} as any,
  );
  const node = createNode('sheets.update', 'update');
  node.config = {
    connectionId: 'google',
    spreadsheetId: 'fixture-sheet',
    range: 'Tab!A:B',
    columns: 'name,email',
  };
  await accessScope.run({ workspaceId: 'workspace' }, () =>
    operations.execute(
      node,
      { rows: [['first', 'second']] },
      {
        workspaceId: 'workspace',
        key: 'task',
        runId: 'run',
        preview: false,
        signal: new AbortController().signal,
        timezone: 'UTC',
        predecessors: [],
      },
    ),
  );
  expect(update.mock.calls[0]![0].requestBody.values).toEqual([['first', 'second']]);
});
