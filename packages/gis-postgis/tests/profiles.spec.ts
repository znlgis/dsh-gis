/**
 * T3.1: a connection profile cannot carry a secret, and describing one never
 * reads the secret.
 *
 * The first assertion is the DoD made mechanical: the schema is strict, so a
 * patch with \`password:\` does not load at all. The rest use the REAL local
 * credentials provider against a temporary file, because "the secret is not
 * echoed" is only worth asserting against something that actually stores one.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { postgisConfigSchema } from '../src/config.ts'
import { PostgisProfileError, PostgisProfiles, type CredentialsResolver } from '../src/profiles.ts'

const SECRET = 'hunter2-do-not-log-me'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A real local credentials provider backed by a temporary file. */
async function realCredentials() {
  const home = await mkdtemp(join(tmpdir(), 'gis-pg-cred-'))
  const path = join(home, 'credentials.yaml')
  const ctx = new Context()
  const provider = new LocalCredentialProvider(ctx, { path, watch: false })
  await provider.ready?.()
  cleanups.push(async () => {
    await provider.dispose?.()
    await rm(home, { recursive: true, force: true })
  })
  return { provider, resolver: provider as unknown as CredentialsResolver, path }
}

/** A resolver that records what it was asked, without being a mock of anything. */
function recordingResolver(configured: boolean) {
  const asked: string[] = []
  const resolver: CredentialsResolver = {
    async resolve(ref) {
      asked.push('resolve:' + String(ref))
      return configured ? { value: SECRET } : undefined
    },
    async describe(ref) {
      asked.push('describe:' + String(ref))
      return { configured }
    },
  }
  return { resolver, asked }
}

const CONFIG = {
  profiles: {
    city: { host: 'db.internal', database: 'gis', user: 'reader', credential: 'postgis_city' },
    local: { host: '127.0.0.1', database: 'gis', user: 'reader' },
  },
}

describe('the configuration', () => {
  it('REFUSES a plaintext password instead of ignoring it', () => {
    const attempt = () => postgisConfigSchema.parse({
      profiles: { city: { host: 'h', database: 'd', user: 'u', password: SECRET } },
    })
    expect(attempt).toThrowError(/password/u)
  })

  it('refuses a plaintext password on a profile that otherwise looks right', () => {
    // The shape most likely to be typed by a user migrating from another tool.
    expect(() => postgisConfigSchema.parse({
      profiles: { city: { host: 'h', port: 5432, database: 'd', user: 'u', password: SECRET, ssl: true } },
    })).toThrowError(/password/u)
  })

  it('refuses a credential REFERENCE the credentials document would reject', () => {
    // A hyphen is the natural thing to type and is not a legal reference. Caught
    // here it is a clear message about this field; uncaught it fails the
    // credentials plugin's own startup with a message about a plugin the user
    // never configured.
    expect(() => postgisConfigSchema.parse({
      profiles: { city: { host: 'h', database: 'd', user: 'u', credential: 'postgis-city' } },
    })).toThrowError(/credential reference/u)
    expect(postgisConfigSchema.parse({
      profiles: { city: { host: 'h', database: 'd', user: 'u', credential: 'postgis_city' } },
    }).profiles.city?.credential).toBe('postgis_city')
  })

  it('applies the connection defaults', () => {
    const parsed = postgisConfigSchema.parse(CONFIG)
    expect(parsed.profiles.city?.port).toBe(5432)
    expect(parsed.profiles.city?.ssl).toBe(false)
    expect(parsed.profiles.city?.statementTimeoutMs).toBe(15_000)
  })
})

describe('describing a profile', () => {
  it('reports the credential state and never the value', async () => {
    const config = postgisConfigSchema.parse(CONFIG)
    const { resolver, asked } = recordingResolver(true)
    const profiles = new PostgisProfiles(config, () => resolver)

    const described = await profiles.describe('city')
    expect(described).toMatchObject({
      profile: 'city',
      host: 'db.internal',
      database: 'gis',
      user: 'reader',
      credential: 'postgis_city',
      credentialState: 'configured',
    })
    // The property that matters: DESCRIBE was asked, resolve never was.
    expect(asked).toEqual(['describe:postgis_city'])
    expect(JSON.stringify(described)).not.toContain(SECRET)
  })

  it('says not-required when the profile has no credential, and unavailable without a service', async () => {
    const config = postgisConfigSchema.parse(CONFIG)
    const profiles = new PostgisProfiles(config)
    expect((await profiles.describe('local'))?.credentialState).toBe('not-required')
    expect((await profiles.describe('city'))?.credentialState).toBe('unavailable')
    expect(await profiles.describe('nope')).toBeUndefined()
  })

  it('finds the secret a real credentials provider stored, and still does not echo it', async () => {
    const { provider, resolver } = await realCredentials()
    await provider.set('postgis_city' as never, SECRET)
    const profiles = new PostgisProfiles(postgisConfigSchema.parse(CONFIG), () => resolver)

    const described = await profiles.describe('city')
    expect(described?.credentialState).toBe('configured')
    expect(JSON.stringify(described)).not.toContain(SECRET)

    const resolved = await profiles.resolve('city')
    expect(resolved.password).toBe(SECRET)
    // …and the redactor is what keeps driver errors out of the log.
    const driverError = 'connection to server failed: postgres://reader:' + SECRET + '@db.internal/gis'
    expect(profiles.redact(driverError, [resolved.password])).not.toContain(SECRET)
    expect(profiles.redact(driverError, [resolved.password])).toContain('***')
  })
})

describe('resolving a profile', () => {
  it('omits a password when the profile declares no credential', async () => {
    const profiles = new PostgisProfiles(postgisConfigSchema.parse(CONFIG))
    expect(await profiles.resolve('local')).not.toHaveProperty('password')
  })

  it('fails with an actionable message for a missing profile or an unconfigured secret', async () => {
    const config = postgisConfigSchema.parse(CONFIG)
    const missing = new PostgisProfiles(config)
    await expect(missing.resolve('nope')).rejects.toThrowError(PostgisProfileError)
    await expect(missing.resolve('city')).rejects.toThrowError(/mounts no credentials service/u)

    const { resolver } = recordingResolver(false)
    await expect(new PostgisProfiles(config, () => resolver).resolve('city')).rejects.toThrowError(/is not configured/u)
  })

  it('carries the timeouts the connection will apply', () => {
    const profiles = new PostgisProfiles(postgisConfigSchema.parse(CONFIG))
    expect(profiles.connectionOf('city')).toMatchObject({ connectTimeoutMs: 10_000, statementTimeoutMs: 15_000, ssl: false })
  })
})
