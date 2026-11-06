import {
  Entity,
  Evidence,
  EvidenceStatus,
  Relation,
  RelationKind,
  Resolution,
  UnknownRegion,
} from "../canonical/model.js";

/** Full on-disk representation of a KnowledgeStore, used by the persistent fact cache. */
export interface StoreSnapshot {
  revision: string;
  entities: Entity[];
  relations: Relation[];
  evidence: Evidence[];
  unknowns: UnknownRegion[];
  fileHashes: [string, string][];
  completed: [string, { at: string; revision: string; scope: string }][];
  seq: number;
}

/**
 * Knowledge layer.
 *
 * Answers: what entities/relations are known, which evidence supports them,
 * which evidence conflicts, which regions are unknown, which facts are stale,
 * and which analysis produced each fact.
 */
export class KnowledgeStore {
  readonly repositoryRoot: string;
  revision: string;

  private entities = new Map<string, Entity>();
  private relations = new Map<string, Relation>();
  private evidence = new Map<string, Evidence>();
  private evidenceBySubject = new Map<string, Set<string>>();
  private unknowns: UnknownRegion[] = [];
  /** file -> content hash at the time it was analyzed */
  private fileHashes = new Map<string, string>();
  /** analysis name -> completion record */
  private completed = new Map<string, { at: string; revision: string; scope: string }>();
  private seq = 0;

  constructor(repositoryRoot: string, revision: string) {
    this.repositoryRoot = repositoryRoot;
    this.revision = revision;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}#${this.seq}`;
  }

  // --------------------------------------------------------- persistence
  /**
   * Full snapshot of every fact currently held, for the persistent cache.
   * Entities/relations/evidence with no `location` (or a location outside
   * any single file, e.g. repository-scoped facts) are included as-is; the
   * cache is responsible for deciding what is safe to reuse per file.
   */
  exportSnapshot(): StoreSnapshot {
    return {
      revision: this.revision,
      entities: this.allEntities(),
      relations: this.allRelations(),
      evidence: this.allEvidence(),
      unknowns: [...this.unknowns],
      fileHashes: [...this.fileHashes.entries()],
      completed: [...this.completed.entries()],
      seq: this.seq,
    };
  }

  /**
   * Bulk-load a previously exported snapshot into this (otherwise empty)
   * store. Preserves original ids and the id-generation counter so newly
   * created facts in this process never collide with cached ones.
   */
  loadSnapshot(snapshot: StoreSnapshot): void {
    for (const e of snapshot.entities) this.entities.set(e.id, e);
    for (const r of snapshot.relations) this.relations.set(r.id, r);
    for (const ev of snapshot.evidence) {
      this.evidence.set(ev.id, ev);
      for (const subject of ev.supports) {
        let set = this.evidenceBySubject.get(subject);
        if (!set) {
          set = new Set();
          this.evidenceBySubject.set(subject, set);
        }
        set.add(ev.id);
      }
    }
    this.unknowns.push(...snapshot.unknowns);
    for (const [file, hash] of snapshot.fileHashes) this.fileHashes.set(file, hash);
    for (const [key, rec] of snapshot.completed) this.completed.set(key, rec);
    this.seq = Math.max(this.seq, snapshot.seq);
  }

  // ---------------------------------------------------------------- entities
  putEntity(entity: Entity): Entity {
    const existing = this.entities.get(entity.id);
    if (existing) {
      existing.attributes = { ...existing.attributes, ...entity.attributes };
      if (!existing.location && entity.location) existing.location = entity.location;
      return existing;
    }
    this.entities.set(entity.id, entity);
    return entity;
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  hasEntity(id: string): boolean {
    return this.entities.has(id);
  }

  allEntities(): Entity[] {
    return [...this.entities.values()];
  }

  entitiesOfKind(kind: Entity["kind"]): Entity[] {
    return this.allEntities().filter((e) => e.kind === kind);
  }

  findEntitiesByName(name: string): Entity[] {
    return this.allEntities().filter((e) => e.name === name);
  }

  // --------------------------------------------------------------- relations
  putRelation(rel: Omit<Relation, "id"> & { id?: string }): Relation {
    const id = rel.id ?? this.nextId(`rel:${rel.kind}`);
    const existing = this.relations.get(id);
    if (existing) return existing;
    const created: Relation = { ...rel, id };
    this.relations.set(id, created);
    return created;
  }

  allRelations(): Relation[] {
    return [...this.relations.values()];
  }

  relationsOfKind(kind: RelationKind): Relation[] {
    return this.allRelations().filter((r) => r.kind === kind);
  }

  relationsTo(targetId: string, kind?: RelationKind): Relation[] {
    return this.allRelations().filter(
      (r) => r.to === targetId && (kind === undefined || r.kind === kind),
    );
  }

  relationsFrom(sourceId: string, kind?: RelationKind): Relation[] {
    return this.allRelations().filter(
      (r) => r.from === sourceId && (kind === undefined || r.kind === kind),
    );
  }

  unresolvedRelations(kind: RelationKind): Relation[] {
    return this.relationsOfKind(kind).filter(
      (r) => r.resolution === Resolution.UNRESOLVED || r.resolution === Resolution.AMBIGUOUS,
    );
  }

  // ---------------------------------------------------------------- evidence
  addEvidence(ev: Omit<Evidence, "id" | "observedAt"> & { id?: string; observedAt?: string }): Evidence {
    const id = ev.id ?? this.nextId("ev");
    const created: Evidence = {
      ...ev,
      id,
      observedAt: ev.observedAt ?? new Date().toISOString(),
    };
    this.evidence.set(id, created);
    for (const subject of created.supports) {
      let set = this.evidenceBySubject.get(subject);
      if (!set) {
        set = new Set();
        this.evidenceBySubject.set(subject, set);
      }
      set.add(id);
    }
    return created;
  }

  evidenceFor(subjectId: string): Evidence[] {
    const ids = this.evidenceBySubject.get(subjectId);
    if (!ids) return [];
    return [...ids].map((id) => this.evidence.get(id)!).filter(Boolean);
  }

  allEvidence(): Evidence[] {
    return [...this.evidence.values()];
  }

  /**
   * Conflicting evidence = two evidence records about the same subject that
   * assert different facts from different source types. Both are retained.
   */
  conflicts(): { subject: string; evidence: Evidence[] }[] {
    const out: { subject: string; evidence: Evidence[] }[] = [];
    for (const [subject, ids] of this.evidenceBySubject) {
      const list = [...ids].map((id) => this.evidence.get(id)!).filter(Boolean);
      const facts = new Set(list.map((e) => e.fact));
      const flagged = list.some((e) => e.status === EvidenceStatus.CONFLICTING);
      if (flagged || (facts.size > 1 && new Set(list.map((e) => e.sourceType)).size > 1)) {
        out.push({ subject, evidence: list });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- unknowns
  addUnknown(region: UnknownRegion): void {
    this.unknowns.push(region);
  }

  unknownRegions(kind?: UnknownRegion["kind"]): UnknownRegion[] {
    return kind ? this.unknowns.filter((u) => u.kind === kind) : [...this.unknowns];
  }

  clearUnknowns(kind: UnknownRegion["kind"]): void {
    this.unknowns = this.unknowns.filter((u) => u.kind !== kind);
  }

  // ------------------------------------------------------- staleness / cache
  recordFileHash(file: string, hash: string): void {
    this.fileHashes.set(file, hash);
  }

  fileHash(file: string): string | undefined {
    return this.fileHashes.get(file);
  }

  knownFiles(): string[] {
    return [...this.fileHashes.keys()];
  }

  /** Files whose current hash differs from the analyzed hash. */
  staleFiles(current: Map<string, string>): string[] {
    const stale: string[] = [];
    for (const [file, hash] of current) {
      const known = this.fileHashes.get(file);
      if (known === undefined || known !== hash) stale.push(file);
    }
    for (const file of this.fileHashes.keys()) {
      if (!current.has(file)) stale.push(file);
    }
    return [...new Set(stale)];
  }

  /** Drop everything derived from a file: entities, relations, evidence. */
  invalidateFile(file: string): void {
    const doomedEntities = this.allEntities().filter((e) => e.location?.file === file);
    const doomedIds = new Set(doomedEntities.map((e) => e.id));
    for (const id of doomedIds) this.entities.delete(id);
    for (const [id, rel] of [...this.relations]) {
      if (rel.location?.file === file || doomedIds.has(rel.from) || (rel.to && doomedIds.has(rel.to))) {
        this.relations.delete(id);
      }
    }
    for (const [id, ev] of [...this.evidence]) {
      if (ev.location?.file === file) {
        this.evidence.delete(id);
        for (const set of this.evidenceBySubject.values()) set.delete(id);
      }
    }
    this.fileHashes.delete(file);
    this.unknowns = this.unknowns.filter((u) => u.location?.file !== file);
  }

  // ---------------------------------------------------------- analysis state
  markAnalysisComplete(name: string, scope: string): void {
    this.completed.set(`${name}|${scope}`, {
      at: new Date().toISOString(),
      revision: this.revision,
      scope,
    });
  }

  isAnalysisComplete(name: string, scope: string): boolean {
    const rec = this.completed.get(`${name}|${scope}`);
    return Boolean(rec && rec.revision === this.revision);
  }

  completedAnalyses(): string[] {
    return [...this.completed.keys()];
  }

  summary(): {
    entities: number;
    relations: number;
    evidence: number;
    unknowns: number;
    conflicts: number;
    files: number;
  } {
    return {
      entities: this.entities.size,
      relations: this.relations.size,
      evidence: this.evidence.size,
      unknowns: this.unknowns.length,
      conflicts: this.conflicts().length,
      files: this.fileHashes.size,
    };
  }
}
