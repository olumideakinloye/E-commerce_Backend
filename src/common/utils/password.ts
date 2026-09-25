import { argon2id, hash, verify, type HashOptions } from 'argon2';

const ARGON2_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await verify(hash, password);
  } catch {
    return false;
  }
}

// Real hash made with the SAME parameters, computed once. Verifying against it when the
// user doesn't exist makes "unknown email" cost the same as "wrong password".
// (A hand-written fake hash can be rejected as malformed and return instantly.)
let dummyHashPromise: Promise<string> | undefined;

export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword('timing-equaliser-not-a-real-password');
  await verifyPassword(await dummyHashPromise, password);
}
