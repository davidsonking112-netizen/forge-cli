import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";

export interface TaskArtifact {
  findings: string[];
  evidence: string[];
  validation: string[];
  edgeCasesConsidered: string[];
  openQuestions: string[];
  confidence: number;
  whatWasNotChecked: string[];
}

export interface TaskNode {
  id: string;
  title: string;
  prompt: string;
  dependsOn: string[];
  status: TaskStatus;
  owner?: string;
  artifact?: TaskArtifact;
  createdAt: string;
  updatedAt: string;
}

export interface TaskGraphSnapshot {
  version: 1;
  nodes: TaskNode[];
  edges: Array<{ from: string; to: string }>;
}

export interface AddTaskInput {
  id?: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
}

function cloneNode(node: TaskNode): TaskNode {
  return {
    ...node,
    dependsOn: [...node.dependsOn],
    artifact: node.artifact
      ? {
          ...node.artifact,
          findings: [...node.artifact.findings],
          evidence: [...node.artifact.evidence],
          validation: [...node.artifact.validation],
          edgeCasesConsidered: [...node.artifact.edgeCasesConsidered],
          openQuestions: [...node.artifact.openQuestions],
          whatWasNotChecked: [...node.artifact.whatWasNotChecked],
        }
      : undefined,
  };
}

export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>();

  addTask(input: AddTaskInput): TaskNode {
    const id = input.id ?? `task_${randomUUID()}`;
    if (this.nodes.has(id)) throw new Error(`Task already exists: ${id}`);
    for (const dependency of input.dependsOn ?? []) {
      if (!this.nodes.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`);
    }
    const node: TaskNode = {
      id,
      title: input.title.trim().slice(0, 300),
      prompt: input.prompt.trim().slice(0, 20_000),
      dependsOn: [...new Set(input.dependsOn ?? [])],
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.nodes.set(id, node);
    if (this.hasCycle()) {
      this.nodes.delete(id);
      throw new Error(`Adding task would create a dependency cycle: ${id}`);
    }
    return cloneNode(node);
  }

  expandTask(parentId: string, children: AddTaskInput[]): TaskNode[] {
    if (!this.nodes.has(parentId)) throw new Error(`Unknown parent task: ${parentId}`);
    const created: TaskNode[] = [];
    try {
      for (const child of children) {
        const dependencySet = new Set(child.dependsOn ?? []);
        dependencySet.add(parentId);
        created.push(this.addTask({ ...child, dependsOn: [...dependencySet] }));
      }
      return created;
    } catch (error) {
      for (const node of created) this.nodes.delete(node.id);
      throw error;
    }
  }

  runnable(): TaskNode[] {
    return [...this.nodes.values()]
      .filter((node) => node.status === "pending")
      .filter((node) => node.dependsOn.every((id) => this.nodes.get(id)?.status === "completed"))
      .map(cloneNode);
  }

  start(id: string, owner?: string): TaskNode {
    const node = this.require(id);
    if (!this.runnable().some((candidate) => candidate.id === id)) {
      throw new Error(`Task is not runnable: ${id}`);
    }
    node.status = "running";
    node.owner = owner;
    node.updatedAt = new Date().toISOString();
    return cloneNode(node);
  }

  complete(id: string, artifact: TaskArtifact): TaskNode {
    const node = this.require(id);
    if (node.status !== "running") throw new Error(`Only running tasks can complete: ${id}`);
    if (artifact.confidence < 0 || artifact.confidence > 1) throw new Error("Artifact confidence must be between 0 and 1");
    if (artifact.evidence.length === 0 && artifact.validation.length === 0) {
      throw new Error(`Task completion requires evidence or validation: ${id}`);
    }
    node.status = "completed";
    node.artifact = artifact;
    node.updatedAt = new Date().toISOString();
    return cloneNode(node);
  }

  fail(id: string, artifact: TaskArtifact): TaskNode {
    const node = this.require(id);
    node.status = "failed";
    node.artifact = artifact;
    node.updatedAt = new Date().toISOString();
    return cloneNode(node);
  }

  cancel(id: string): TaskNode {
    const node = this.require(id);
    if (node.status === "completed") throw new Error(`Completed task cannot be cancelled: ${id}`);
    node.status = "cancelled";
    node.updatedAt = new Date().toISOString();
    return cloneNode(node);
  }

  blocked(): TaskNode[] {
    return [...this.nodes.values()]
      .filter((node) => node.status === "pending")
      .filter((node) => node.dependsOn.some((id) => {
        const dependency = this.nodes.get(id);
        return dependency?.status === "failed" || dependency?.status === "cancelled";
      }))
      .map((node) => {
        const next = this.nodes.get(node.id)!;
        next.status = "blocked";
        next.updatedAt = new Date().toISOString();
        return cloneNode(next);
      });
  }

  snapshot(): TaskGraphSnapshot {
    const nodes = [...this.nodes.values()].map(cloneNode);
    return {
      version: 1,
      nodes,
      edges: nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id }))),
    };
  }

  static fromSnapshot(snapshot: TaskGraphSnapshot): TaskGraph {
    if (snapshot.version !== 1) throw new Error(`Unsupported task graph version: ${snapshot.version}`);
    const graph = new TaskGraph();
    for (const node of snapshot.nodes) {
      if (graph.nodes.has(node.id)) throw new Error(`Duplicate task id: ${node.id}`);
      graph.nodes.set(node.id, cloneNode(node));
    }
    if (graph.hasCycle()) throw new Error("Snapshot contains a dependency cycle");
    for (const node of graph.nodes.values()) {
      for (const dependency of node.dependsOn) {
        if (!graph.nodes.has(dependency)) throw new Error(`Snapshot references missing dependency: ${dependency}`);
      }
    }
    return graph;
  }

  private require(id: string): TaskNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown task: ${id}`);
    return node;
  }

  private hasCycle(): boolean {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const node = this.nodes.get(id);
      if (node && node.dependsOn.some(visit)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    return [...this.nodes.keys()].some(visit);
  }
}
