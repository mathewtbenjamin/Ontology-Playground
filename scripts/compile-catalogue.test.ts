import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { serializeToRDF } from '../src/lib/rdf/serializer';
import { parseRDF } from '../src/lib/rdf/parser';
import {
  CatalogueDiscoveryError,
  compileCatalogue,
  discoverOntologyDirs,
  runCatalogueCompiler,
} from './compile-catalogue';

const ROOT = join(import.meta.dirname, '..');
const CATALOGUE_JSON = join(ROOT, 'public', 'catalogue.json');
const COMMUNITY_DIR = join(ROOT, 'catalogue', 'community');

interface CatalogueTestEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  source: 'official' | 'community' | 'external';
  license?: string;
  sourceUrl?: string;
  version?: string;
  ontology: {
    entityTypes: { name: string; properties: { isIdentifier?: boolean }[] }[];
    relationships: unknown[];
  };
  bindings: unknown[];
}

interface CatalogueTestOutput {
  count: number;
  generatedAt: string;
  entries: CatalogueTestEntry[];
}

function readCatalogue(): CatalogueTestOutput {
  return JSON.parse(readFileSync(CATALOGUE_JSON, 'utf-8')) as CatalogueTestOutput;
}

function findEntry(id: string): CatalogueTestEntry {
  const entry = readCatalogue().entries.find((candidate) => candidate.id === id);
  expect(entry).toBeTruthy();
  return entry as CatalogueTestEntry;
}

const temporaryDirectories: string[] = [];

function createTemporaryCatalogue(): string {
  const root = mkdtempSync(join(tmpdir(), 'ontology-catalogue-test-'));
  temporaryDirectories.push(root);

  for (const tier of ['official', 'community', 'external']) {
    mkdirSync(join(root, tier));
  }

  return root;
}

function createDirectory(root: string, relativePath: string): string {
  const path = join(root, relativePath);
  mkdirSync(path, { recursive: true });
  return path;
}

function createDirectorySymlink(root: string, relativePath: string): string {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'ontology-catalogue-symlink-target-'),
  );
  temporaryDirectories.push(targetRoot);
  const target = createDirectory(
    targetRoot,
    relativePath.replaceAll('/', '-'),
  );
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  return path;
}

function createFileSymlink(root: string, relativePath: string): string {
  const targetRoot = mkdtempSync(
    join(tmpdir(), 'ontology-catalogue-file-target-'),
  );
  temporaryDirectories.push(targetRoot);
  const target = join(targetRoot, relativePath.replaceAll('/', '-'));
  writeFileSync(target, 'symlink target\n');
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'file');
  return path;
}

function supportsFileSymlinks(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'ontology-symlink-capability-'));
  const target = join(root, 'target');
  const link = join(root, 'link');

  try {
    writeFileSync(target, 'target\n');
    symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
      return false;
    }
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FILE_SYMLINKS_SUPPORTED = supportsFileSymlinks();

function createCatalogueRootSymlink(): string {
  const parent = mkdtempSync(join(tmpdir(), 'ontology-catalogue-root-test-'));
  temporaryDirectories.push(parent);
  const target = createDirectory(parent, 'target');
  for (const tier of ['official', 'community', 'external']) {
    mkdirSync(join(target, tier));
  }
  const path = join(parent, 'catalogue');
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  return path;
}

const DISCOVERY_PARENT_PATHS = [
  'official',
  'community',
  'community/alice',
  'external',
  'external/schema-org',
];

const UNSAFE_DIRECTORY_NAMES = [
  'Uppercase',
  'with space',
  '..-traversal-like',
  'contains.dot',
  'percent%encoded',
];

const UNSAFE_DIRECTORY_CASES = DISCOVERY_PARENT_PATHS.flatMap(
  (parent) => UNSAFE_DIRECTORY_NAMES.map((name) => [parent, name] as const),
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('catalogue compilation (end-to-end)', () => {
  it('npm run catalogue:build succeeds with the real catalogue', () => {
    const result = execSync('npx tsx scripts/compile-catalogue.ts', {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(result).toContain('official/cosmic-coffee');
    expect(result).toContain('official/ecommerce');

    const output = readCatalogue();
    expect(output.count).toBe(output.entries.length);
    expect(output.entries.length).toBeGreaterThan(0);
    expect(output.generatedAt).toBeTruthy();
  }, 35000);

  it('catalogue.json entries have required fields', () => {
    const output = readCatalogue();
    for (const entry of output.entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(['official', 'community', 'external']).toContain(entry.source);
      expect(entry.ontology).toBeTruthy();
      expect(entry.ontology.entityTypes.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.bindings)).toBe(true);
      expect(Array.isArray(entry.tags)).toBe(true);
    }
  });

  it('cosmic-coffee entry preserves data bindings', () => {
    const coffee = readCatalogue().entries.find((e: { id: string }) => e.id === 'official/cosmic-coffee');
    expect(coffee).toBeTruthy();
    expect(coffee.bindings.length).toBeGreaterThan(0);
    expect(coffee.bindings[0].table).toBeTruthy();
    expect(coffee.bindings[0].columnMappings).toBeTruthy();
  });

  it('all ontologies round-trip through RDF serialization', () => {
    for (const entry of readCatalogue().entries) {
      const rdf = serializeToRDF(entry.ontology, entry.bindings);
      const reparsed = parseRDF(rdf);
      expect(reparsed.ontology.entityTypes.length).toBe(entry.ontology.entityTypes.length);
      expect(reparsed.ontology.relationships.length).toBe(entry.ontology.relationships.length);
    }
  });
});

describe('catalogue directory discovery', () => {
  it('returns safe directory names and ignores incidental regular files', () => {
    const root = createTemporaryCatalogue();
    const tierDir = join(root, 'official');
    const safeDirectories = ['a', 'alpha-1', 'alpha_beta'];

    for (const name of safeDirectories) {
      createDirectory(tierDir, name);
    }
    writeFileSync(join(tierDir, 'README.md'), 'Tier documentation\n');

    expect(discoverOntologyDirs(tierDir).map((path) => basename(path)).sort()).toEqual(
      safeDirectories.sort(),
    );
  });

  it.each([
    'Uppercase',
    'with space',
    '..-traversal-like',
    'contains.dot',
    'percent%encoded',
  ])('rejects the unsafe directory name %s', (name) => {
    const root = createTemporaryCatalogue();
    const tierDir = join(root, 'official');
    const path = createDirectory(tierDir, name);

    expect(() => discoverOntologyDirs(tierDir)).toThrow(CatalogueDiscoveryError);
    expect(() => discoverOntologyDirs(tierDir)).toThrow(
      `${path}: directory name contains unsafe characters`,
    );
  });
});

describe('catalogue discovery failures', () => {
  it.each([
    'OfficialCopy',
    'commmunity',
    'staging',
    'with space',
  ])('fails for the unexpected catalogue root directory %s', (name) => {
    const root = createTemporaryCatalogue();
    const invalidPath = createDirectory(root, name);
    const outputPath = join(root, 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      CatalogueDiscoveryError,
    );
    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      `${invalidPath}: unexpected catalogue root directory`,
    );
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
  });

  it('fails for a symlink directly under the catalogue root', () => {
    const root = createTemporaryCatalogue();
    const symlinkPath = createDirectorySymlink(root, 'unexpected-tier');
    const outputPath = join(root, 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      `${symlinkPath}: symlinks are not allowed in the catalogue`,
    );
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
  });

  it.each(UNSAFE_DIRECTORY_CASES)(
    'fails for the unsafe directory %s/%s and preserves existing output',
    (parent, name) => {
    const root = createTemporaryCatalogue();
    const relativePath = `${parent}/${name}`;
    const invalidPath = createDirectory(root, relativePath);
    const outputPath = join(root, 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      CatalogueDiscoveryError,
    );
    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      `${invalidPath}: directory name contains unsafe characters`,
    );
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
    },
  );

  it.each([
    'official/symlink',
    'community/symlink',
    'community/alice/symlink',
    'external/symlink',
    'external/schema-org/symlink',
  ])('fails for a symlink at %s and preserves existing output', (relativePath) => {
    const root = createTemporaryCatalogue();
    const symlinkPath = createDirectorySymlink(root, relativePath);
    const outputPath = join(root, 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      CatalogueDiscoveryError,
    );
    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      `${symlinkPath}: symlinks are not allowed in the catalogue`,
    );
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
  });

  it.each([
    'official',
    'community',
    'external',
  ])('fails when the %s tier is a symlink and preserves existing output', (tier) => {
    const root = createTemporaryCatalogue();
    const tierPath = join(root, tier);
    rmSync(tierPath, { recursive: true });
    createDirectorySymlink(root, tier);
    const outputPath = join(root, 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      CatalogueDiscoveryError,
    );
    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      `${tierPath}: symlinks are not allowed in the catalogue`,
    );
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
  });

  it('fails when the catalogue root is a symlink and preserves existing output', () => {
    const root = createCatalogueRootSymlink();
    const outputPath = join(dirname(root), 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      CatalogueDiscoveryError,
    );
    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      `${root}: symlinks are not allowed in the catalogue`,
    );
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
  });

  it('ignores incidental regular files at grouping levels', () => {
    const root = createTemporaryCatalogue();
    const files = [
      'official/README.md',
      'community/README.md',
      'community/alice/README.md',
      'external/README.md',
      'external/schema-org/README.md',
    ];

    for (const relativePath of files) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
    }

    expect(compileCatalogue(root)).toMatchObject({
      count: 0,
      entries: [],
    });
  });

  it('treats an empty entry directory as invalid and preserves existing output', () => {
    const root = createTemporaryCatalogue();
    const emptyEntry = createDirectory(root, 'official/empty-entry');
    const outputPath = join(root, 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      'Catalogue compilation failed with 1 error(s)',
    );
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
    expect(readdirSync(emptyEntry)).toEqual([]);
  });

  describe.skipIf(!FILE_SYMLINKS_SUPPORTED)(
    'ontology entry file symlinks',
    () => {
      it.each([
        'metadata.json',
        'ontology.rdf',
        'README.md',
      ])('fails for a symlinked %s inside an ontology entry', (file) => {
        const root = createTemporaryCatalogue();
        const symlinkPath = createFileSymlink(
          root,
          `official/symlinked-file/${file}`,
        );
        const outputPath = join(root, 'catalogue.json');
        writeFileSync(outputPath, 'previous valid catalogue\n');

        expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
          `${symlinkPath}: symlinks are not allowed in the catalogue`,
        );
        expect(readFileSync(outputPath, 'utf-8')).toBe(
          'previous valid catalogue\n',
        );
      });
    },
  );

  it('fails for a nested directory inside an ontology entry', () => {
    const root = createTemporaryCatalogue();
    const nestedPath = createDirectory(
      root,
      'official/nested-entry/unexpected',
    );
    const outputPath = join(root, 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath)).toThrow(
      `${nestedPath}: nested directories are not allowed inside an ontology entry`,
    );
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
  });

  it('fails if an ontology directory changes after discovery', () => {
    const root = createTemporaryCatalogue();
    const entry = createDirectory(root, 'official/replaced-entry');
    const metadataPath = join(entry, 'metadata.json');
    writeFileSync(metadataPath, '{}');
    writeFileSync(join(entry, 'ontology.rdf'), '<rdf:RDF />');
    const replacementRoot = mkdtempSync(
      join(tmpdir(), 'ontology-entry-replacement-'),
    );
    temporaryDirectories.push(replacementRoot);
    const replacement = createDirectory(replacementRoot, 'entry');
    writeFileSync(join(replacement, 'metadata.json'), '{}');
    writeFileSync(join(replacement, 'ontology.rdf'), '<rdf:RDF />');
    const outputPath = join(root, 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath, {
      beforeFileOpen: (path) => {
        if (path !== metadataPath) return;
        rmSync(entry, { recursive: true });
        symlinkSync(
          replacement,
          entry,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    })).toThrow(`${entry}: symlinks are not allowed in the catalogue`);
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
  });

  it('fails if a required file changes after discovery', () => {
    const root = createTemporaryCatalogue();
    const entry = createDirectory(root, 'official/replaced-file');
    const metadataPath = join(entry, 'metadata.json');
    writeFileSync(metadataPath, '{}');
    writeFileSync(join(entry, 'ontology.rdf'), '<rdf:RDF />');
    const outputPath = join(root, 'catalogue.json');
    writeFileSync(outputPath, 'previous valid catalogue\n');

    expect(() => runCatalogueCompiler(root, outputPath, {
      beforeFileOpen: (path) => {
        if (path !== metadataPath) return;
        rmSync(metadataPath);
        writeFileSync(metadataPath, '{"replacement":true}');
      },
    })).toThrow(
      `${entry}: filesystem entry changed during catalogue compilation`,
    );
    expect(readFileSync(outputPath, 'utf-8')).toBe('previous valid catalogue\n');
  });
});

describe('catalogue metadata validation', () => {
  it('all entries reference valid categories', () => {
    const validCats = ['retail', 'healthcare', 'finance', 'manufacturing', 'education', 'general', 'food', 'media', 'events', 'technology', 'iq-lab', 'school', 'fibo'];
    for (const entry of readCatalogue().entries) {
      expect(validCats).toContain(entry.category);
    }
  });

  it('all entries have path-based ids', () => {
    for (const entry of readCatalogue().entries) {
      expect(entry.id).toMatch(/^(official|community|external)\//);
      expect(entry.id).not.toContain('\\');
    }
  });

  it('preserves external and community attribution metadata', () => {
    const externalEntries = readCatalogue().entries.filter(
      (entry) => entry.source === 'external',
    );

    expect(externalEntries.length).toBeGreaterThan(0);
    for (const entry of externalEntries) {
      expect(entry.license).toBeTruthy();
      expect(entry.sourceUrl).toMatch(/^https:\/\//);
    }

    const brick = findEntry('external/brick-schema/brick');
    expect(brick.license).toBe('BSD-3-Clause');
    expect(brick.sourceUrl).toBe('https://github.com/BrickSchema/Brick/tree/v1.4.4');
    expect(brick.version).toBe('1.4.4');

    const fibo = findEntry('external/fibo/geographic-hierarchy');
    expect(fibo.license).toBe('MIT');
    expect(fibo.sourceUrl).toBe('https://github.com/edmcouncil/fibo');

    const openIm = findEntry('community/antikas/openim');
    expect(openIm.license).toBe('MIT');
    expect(openIm.sourceUrl).toBe(
      'https://github.com/antikas/open-investment-model/tree/v0.2.1',
    );
    expect(openIm.version).toBe('0.2.1');
  });

  it('community entries use username and slug path ids', () => {
    for (const entry of readCatalogue().entries.filter((candidate) => candidate.source === 'community')) {
      const parts = entry.id.split('/');
      expect(parts).toHaveLength(3);
      expect(parts[1]).toBeTruthy();
      expect(parts[2]).toBeTruthy();
    }
  });

  it('community source folders contain only username/slug ontology entries', () => {
    for (const username of readdirSync(COMMUNITY_DIR)) {
      const userDir = join(COMMUNITY_DIR, username);
      if (!statSync(userDir).isDirectory()) {
        expect(username).toBe('README.md');
        continue;
      }

      for (const slug of readdirSync(userDir)) {
        const slugDir = join(userDir, slug);
        if (!statSync(slugDir).isDirectory()) {
          expect(slug).toBe('README.md');
          continue;
        }
        expect(existsSync(join(slugDir, 'metadata.json'))).toBe(true);

        const rdfFiles = readdirSync(slugDir).filter((file) => file.endsWith('.rdf') || file.endsWith('.owl'));
        expect(rdfFiles.length).toBeGreaterThan(0);
      }
    }
  });

  it('includes the supply chain disruption community ontology', () => {
    const entry = findEntry('community/ravi-chandu/supply-chain-disruption-risk-propagation');
    const entityNames = entry.ontology.entityTypes.map((entity) => entity.name);
    const identifierCount = entry.ontology.entityTypes.filter((entity) =>
      entity.properties.some((property) => property.isIdentifier),
    ).length;

    expect(entry.name).toBe('Supply Chain Disruption & Risk Propagation');
    expect(entry.category).toBe('manufacturing');
    expect(entry.author).toBe('Ravi Chandu Edru');
    expect(entry.tags).toEqual(expect.arrayContaining(['supply-chain', 'risk', 'operations', 'mitigation']));
    expect(entityNames).toEqual(expect.arrayContaining([
      'Supplier',
      'Component',
      'ProductLine',
      'DisruptionEvent',
      'RiskAssessment',
      'MitigationAction',
      'AlternativeSupplier',
    ]));
    expect(entry.ontology.entityTypes.length).toBeGreaterThanOrEqual(7);
    expect(entry.ontology.relationships.length).toBeGreaterThanOrEqual(7);
    expect(identifierCount).toBe(entry.ontology.entityTypes.length);
  });
});
