declare module "cytoscape" {
  type CytoscapeElementPayload = {
    group: "nodes" | "edges";
    data: {
      id?: string;
      source?: string;
      target?: string;
      label?: string;
      kind?: string;
      status?: string;
      role?: string;
    };
  };

  type CytoscapeCollection = {
    addClass(className: string): CytoscapeCollection;
    removeClass(className: string): CytoscapeCollection;
  };

  type CytoscapeNode = {
    id(): string;
    closedNeighborhood(): CytoscapeCollection;
    connectedEdges(): CytoscapeCollection;
  };

  type CytoscapeCore = {
    elements(): CytoscapeCollection & {
      not(collection: CytoscapeCollection): CytoscapeCollection;
    };
    on(eventName: string, selector: string, handler: (event: { target: CytoscapeNode }) => void): void;
    destroy(): void;
  };

  type CytoscapeFactory = (options: {
    container: HTMLElement;
    elements: CytoscapeElementPayload[];
    style: Array<{ selector: string; style: Record<string, string | number> }>;
    layout: { name: "cose"; animate: boolean; fit: boolean; padding: number };
  }) => CytoscapeCore;

  const cytoscape: CytoscapeFactory;
  export default cytoscape;
}
