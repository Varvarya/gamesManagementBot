export class TrainingRegistrationLock {
    private readonly tails = new Map<string, Promise<void>>();

    async run<T>(trainingId: string, action: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(trainingId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        this.tails.set(trainingId, tail);
        await previous;
        try { return await action(); }
        finally {
            release();
            if (this.tails.get(trainingId) === tail) this.tails.delete(trainingId);
        }
    }
}
