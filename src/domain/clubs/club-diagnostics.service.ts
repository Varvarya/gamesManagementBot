import fs from 'node:fs/promises';
import path from 'node:path';
import { ClubRepository } from '../../storage/repositories/club.repository';

export type ClubContextLoadFailureCode = 'CLUB_NOT_FOUND' | 'STORAGE_NOT_FOUND' | 'SETTINGS_NOT_FOUND' | 'SETTINGS_INVALID' | 'CLUB_ID_MISMATCH' | 'STORAGE_SLUG_MISMATCH' | 'REPOSITORY_CORRUPT' | 'REPOSITORY_LOAD_FAILED' | 'CONTEXT_MISMATCH' | 'UNKNOWN';
export type ClubContextLoadFailure = { code: ClubContextLoadFailureCode; clubId: string; clubTitle?: string; storageSlug?: string; directoryPath?: string; settingsPath?: string; settingsClubId?: string; repository?: string; technicalMessage?: string };
export type RepositoryDiagnostic = { exists: boolean; valid: boolean; optional: boolean; error?: string };
export type ClubDiagnostics = { clubFound: boolean; clubId: string; title?: string; storageSlug?: string; directoryPath?: string; directoryExists: boolean; settingsPath?: string; settingsExists: boolean; settingsValid?: boolean; registryClubId?: string; settingsClubId?: string; clubIdMatches?: boolean; repositories: { players: RepositoryDiagnostic; chats: RepositoryDiagnostic; schedule: RepositoryDiagnostic; trainings: RepositoryDiagnostic }; contextLoadable: boolean; failure?: ClubContextLoadFailure };

const emptyRepository = (): RepositoryDiagnostic => ({ exists: false, valid: true, optional: true });

export class ClubDiagnosticsService {
    constructor(private readonly clubs: ClubRepository, private readonly dataDir: string) {}

    async diagnose(clubId: string): Promise<ClubDiagnostics> {
        const repositories = { players: emptyRepository(), chats: emptyRepository(), schedule: emptyRepository(), trainings: emptyRepository() };
        let club;
        try { club = await this.clubs.findById(clubId); }
        catch (error) { return this.unknown(clubId, repositories, error); }
        if (!club) return { clubFound: false, clubId, directoryExists: false, settingsExists: false, repositories, contextLoadable: false, failure: { code: 'CLUB_NOT_FOUND', clubId, technicalMessage: `Club ${clubId} is absent from the registry` } };
        const root = path.resolve(this.dataDir);
        const directoryPath = path.resolve(root, club.slug);
        const settingsPath = path.join(directoryPath, 'settings.json');
        const base = { clubFound: true, clubId, title: club.name, storageSlug: club.slug, registryClubId: club.id, directoryPath, settingsPath, repositories };
        if (path.dirname(directoryPath) !== root || path.basename(directoryPath) !== club.slug) return this.failed(base, false, false, { code: 'STORAGE_SLUG_MISMATCH', clubId, clubTitle: club.name, storageSlug: club.slug, directoryPath, technicalMessage: 'storageSlug resolves outside DATA_DIR' });
        const directoryExists = await isDirectory(directoryPath);
        if (!directoryExists) return this.failed(base, false, false, { code: 'STORAGE_NOT_FOUND', clubId, clubTitle: club.name, storageSlug: club.slug, directoryPath, technicalMessage: `Directory does not exist: ${directoryPath}` });
        const settingsExists = await isFile(settingsPath);
        if (!settingsExists) return this.failed(base, true, false, { code: 'SETTINGS_NOT_FOUND', clubId, clubTitle: club.name, storageSlug: club.slug, directoryPath, settingsPath, technicalMessage: `File does not exist: ${settingsPath}` });
        let settings: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
            const value = isObject(parsed) && 'data' in parsed ? parsed.data : parsed;
            if (!isObject(value)) throw new Error('settings.json data must be an object');
            settings = value;
        } catch (error) {
            return { ...base, directoryExists: true, settingsExists: true, settingsValid: false, contextLoadable: false, failure: failure('SETTINGS_INVALID', base, error, { settingsPath }) };
        }
        const settingsClubId = typeof settings.clubId === 'string' ? settings.clubId : undefined;
        if (!settingsClubId) return { ...base, directoryExists: true, settingsExists: true, settingsValid: false, settingsClubId, clubIdMatches: false, contextLoadable: false, failure: failure('SETTINGS_INVALID', base, new Error('settings.data.clubId must be a string'), { settingsPath }) };
        if (settingsClubId !== club.id) return { ...base, directoryExists: true, settingsExists: true, settingsValid: true, settingsClubId, clubIdMatches: false, contextLoadable: false, failure: { code: 'CLUB_ID_MISMATCH', clubId, clubTitle: club.name, storageSlug: club.slug, directoryPath, settingsPath, settingsClubId, technicalMessage: `Registry clubId ${club.id} does not match settings.clubId ${settingsClubId}` } };
        if (typeof settings.storageSlug === 'string' && settings.storageSlug !== club.slug) return { ...base, directoryExists: true, settingsExists: true, settingsValid: true, settingsClubId, clubIdMatches: true, contextLoadable: false, failure: { code: 'STORAGE_SLUG_MISMATCH', clubId, clubTitle: club.name, storageSlug: club.slug, directoryPath, settingsPath, settingsClubId, technicalMessage: `Registry storageSlug ${club.slug} does not match settings.storageSlug ${settings.storageSlug}` } };
        const specs = [['players', 'players.json', 'array'], ['chats', 'chats.json', 'collection'], ['schedule', 'templates.json', 'array'], ['trainings', 'trainings.json', 'array']] as const;
        for (const [name, file, shape] of specs) {
            const diagnostic = await inspectRepository(path.join(directoryPath, file), shape);
            repositories[name] = diagnostic;
            if (!diagnostic.valid) return { ...base, directoryExists: true, settingsExists: true, settingsValid: true, settingsClubId, clubIdMatches: true, contextLoadable: false, failure: { code: 'REPOSITORY_CORRUPT', clubId, clubTitle: club.name, storageSlug: club.slug, directoryPath, settingsPath, settingsClubId, repository: name, technicalMessage: diagnostic.error } };
        }
        return { ...base, directoryExists: true, settingsExists: true, settingsValid: true, settingsClubId, clubIdMatches: true, contextLoadable: true };
    }

    private failed(base: Omit<ClubDiagnostics, 'directoryExists' | 'settingsExists' | 'contextLoadable'>, directoryExists: boolean, settingsExists: boolean, loadFailure: ClubContextLoadFailure): ClubDiagnostics { return { ...base, directoryExists, settingsExists, contextLoadable: false, failure: loadFailure }; }
    private unknown(clubId: string, repositories: ClubDiagnostics['repositories'], error: unknown): ClubDiagnostics { return { clubFound: false, clubId, directoryExists: false, settingsExists: false, repositories, contextLoadable: false, failure: { code: 'UNKNOWN', clubId, technicalMessage: errorMessage(error) } }; }
}

async function inspectRepository(file: string, shape: 'array' | 'collection'): Promise<RepositoryDiagnostic> { if (!await isFile(file)) return emptyRepository(); try { const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8')); const value = isObject(parsed) && 'data' in parsed ? parsed.data : parsed; const valid = shape === 'array' ? Array.isArray(value) : Array.isArray(value) || isObject(value); return valid ? { exists: true, valid: true, optional: true } : { exists: true, valid: false, optional: true, error: `${path.basename(file)} has an invalid data shape` }; } catch (error) { return { exists: true, valid: false, optional: true, error: errorMessage(error) }; } }
function failure(code: ClubContextLoadFailureCode, base: { clubId: string; title?: string; storageSlug?: string; directoryPath?: string }, error: unknown, extra: Partial<ClubContextLoadFailure> = {}): ClubContextLoadFailure { return { code, clubId: base.clubId, clubTitle: base.title, storageSlug: base.storageSlug, directoryPath: base.directoryPath, technicalMessage: errorMessage(error), ...extra }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
async function isDirectory(value: string): Promise<boolean> { try { return (await fs.stat(value)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function isFile(value: string): Promise<boolean> { try { return (await fs.stat(value)).isFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
