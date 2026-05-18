import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    spawnSync: vi.fn()
}));

vi.mock('node:child_process', () => ({
    spawn: mocks.spawn,
    spawnSync: mocks.spawnSync
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn()
    }
}));

import { TerminalManager } from './TerminalManager';

type MockChild = EventEmitter & {
    stdin: PassThrough;
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
};

function createMockChild(): { child: MockChild; stdinLines: string[] } {
    const stdin = new PassThrough();
    const stdinLines: string[] = [];
    stdin.on('data', (chunk) => {
        stdinLines.push(chunk.toString());
    });

    const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        exitCode: null,
        kill: vi.fn(function (this: MockChild) {
            this.killed = true;
            this.exitCode = 0;
        })
    }) as MockChild;

    return { child, stdinLines };
}

describe('TerminalManager', () => {
    const originalShell = process.env.SHELL;
    const originalDisableScriptPty = process.env.HAPI_TERMINAL_DISABLE_SCRIPT_PTY;
    const originalUseBunPty = process.env.HAPI_TERMINAL_USE_BUN_PTY;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.SHELL = '/bin/bash';
        delete process.env.HAPI_TERMINAL_DISABLE_SCRIPT_PTY;
        delete process.env.HAPI_TERMINAL_USE_BUN_PTY;
        mocks.spawnSync.mockImplementation((command: string) => ({
            status: command === 'python3' ? 0 : 1
        }));
    });

    afterEach(() => {
        if (originalShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = originalShell;

        if (originalDisableScriptPty === undefined) delete process.env.HAPI_TERMINAL_DISABLE_SCRIPT_PTY;
        else process.env.HAPI_TERMINAL_DISABLE_SCRIPT_PTY = originalDisableScriptPty;

        if (originalUseBunPty === undefined) delete process.env.HAPI_TERMINAL_USE_BUN_PTY;
        else process.env.HAPI_TERMINAL_USE_BUN_PTY = originalUseBunPty;
    });

    it('uses the Python PTY bridge for runner remote terminals and forwards writes/resizes', () => {
        const { child, stdinLines } = createMockChild();
        mocks.spawn.mockReturnValue(child);
        const onReady = vi.fn();
        const onOutput = vi.fn();
        const onExit = vi.fn();
        const onError = vi.fn();

        const manager = new TerminalManager({
            sessionId: 'session-1',
            getSessionPath: () => '/workspace/project',
            onReady,
            onOutput,
            onExit,
            onError,
            idleTimeoutMs: 0
        });

        manager.create('terminal-1', 80, 24);
        manager.write('terminal-1', 'echo ok\n');
        manager.resize('terminal-1', 100, 30);
        child.stdout.emit('data', Buffer.from('ok\r\n'));
        child.emit('exit', 0, null);

        expect(mocks.spawnSync).toHaveBeenCalledWith('python3', ['--version'], { stdio: 'ignore' });
        expect(mocks.spawn).toHaveBeenCalledWith(
            'python3',
            [
                '-c',
                expect.stringContaining('TIOCSWINSZ'),
                '/bin/bash',
                '80',
                '24'
            ],
            expect.objectContaining({
                cwd: '/workspace/project',
                stdio: ['pipe', 'pipe', 'pipe']
            })
        );
        const pythonScript = mocks.spawn.mock.calls[0]?.[1]?.[1] as string;
        expect(pythonScript).toContain('TIOCSCTTY');
        expect(pythonScript).toContain('terminate_child_group');
        expect(pythonScript).toContain('os.killpg(proc.pid, sig)');
        expect(onReady).toHaveBeenCalledWith({ sessionId: 'session-1', terminalId: 'terminal-1' });
        expect(JSON.parse(stdinLines[0] ?? '{}')).toEqual({
            type: 'write',
            data: Buffer.from('echo ok\n').toString('base64')
        });
        expect(JSON.parse(stdinLines[1] ?? '{}')).toEqual({
            type: 'resize',
            cols: 100,
            rows: 30
        });
        expect(onOutput).toHaveBeenCalledWith({ sessionId: 'session-1', terminalId: 'terminal-1', data: 'ok\r\n' });
        expect(onExit).toHaveBeenCalledWith({ sessionId: 'session-1', terminalId: 'terminal-1', code: 0, signal: null });
        expect(onError).not.toHaveBeenCalled();
    });
});
