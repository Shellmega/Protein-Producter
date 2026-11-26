/**
 * Bridge to the vendored Mol* 5.13.0 build.
 *
 * The frozen Mol* distribution ships as a classic-script bundle under
 * `/vendor/molstar.js` (UMD → `globalThis.molstar`), which is what the browser
 * loads; no bundler and no module graph of thousands of files is involved.
 *
 * The viewer-app bundle exposes a curated top level (`Viewer`, `PluginExtensions`,
 * …) plus the library namespaces under `molstar.lib`; the engine pieces we need
 * live there (`molstar.lib.plugin.PluginContext`,
 * `molstar.lib.structure.StructureElement`, …). The accessor below resolves that
 * layout explicitly and fails loudly rather than guessing, and the types are the
 * real ones from the package's `.d.ts` files so this code is type-checked against
 * Mol* itself.
 */

import type { PluginContext } from "molstar/lib/mol-plugin/context.js";
import type { PluginSpec } from "molstar/lib/mol-plugin/spec.js";
import type { Loci } from "molstar/lib/mol-model/structure/structure/element/loci.js";
import type { Location } from "molstar/lib/mol-model/structure/structure/element/location.js";

interface LociNamespace {
  getFirstLocation(loci: Loci, location?: Location): Location | undefined;
  size(loci: Loci): number;
}

interface StructurePropertiesNamespace {
  atom: {
    label_atom_id(location: Location): string;
    id(location: Location): number;
  };
  residue: {
    label_comp_id(location: Location): string;
    auth_seq_id(location: Location): number;
  };
  chain: {
    auth_asym_id(location: Location): string;
  };
}

interface LinearAlgebraNamespace {
  Vec3: {
    transformMat4(out: unknown, a: unknown, m: unknown): unknown;
  };
  Mat4: unknown;
}

export interface MolstarGlobal {
  version?: string;
  PluginContext: new (spec: PluginSpec) => PluginContext;
  DefaultPluginSpec: () => PluginSpec;
  StructureElement: { Loci: LociNamespace };
  StructureProperties: StructurePropertiesNamespace;
  LinearAlgebra: LinearAlgebraNamespace;
}

export class MolstarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MolstarUnavailableError";
  }
}

interface MolstarNamespaceBag {
  PluginContext?: MolstarGlobal["PluginContext"];
  DefaultPluginSpec?: MolstarGlobal["DefaultPluginSpec"];
  StructureElement?: MolstarGlobal["StructureElement"];
  StructureProperties?: MolstarGlobal["StructureProperties"];
}

interface MolstarRoot {
  version?: string;
  lib?: {
    plugin?: MolstarNamespaceBag;
    structure?: MolstarNamespaceBag;
    math?: { LinearAlgebra?: LinearAlgebraNamespace };
  };
}

/**
 * Resolve the vendored Mol* namespaces. Support both the nested layout of the
 * viewer bundle and a flat layout, so a rebuild of the same version keeps working,
 * but refuse to continue with a partial engine.
 */
export function getMolstar(): MolstarGlobal {
  const root = (globalThis as unknown as { molstar?: MolstarRoot }).molstar;
  if (!root) {
    throw new MolstarUnavailableError("Mol* 未加载：缺少 /vendor/molstar.js 提供的全局 molstar");
  }
  const plugin = root.lib?.plugin ?? {};
  const structure = root.lib?.structure ?? {};
  const PluginContext = plugin.PluginContext ?? (root as MolstarNamespaceBag).PluginContext;
  const DefaultPluginSpec = plugin.DefaultPluginSpec ?? (root as MolstarNamespaceBag).DefaultPluginSpec;
  const StructureElement = structure.StructureElement ?? (root as MolstarNamespaceBag).StructureElement;
  const StructureProperties = structure.StructureProperties ?? (root as MolstarNamespaceBag).StructureProperties;
  const LinearAlgebra = root.lib?.math?.LinearAlgebra ?? (root as { LinearAlgebra?: LinearAlgebraNamespace }).LinearAlgebra;
  if (!PluginContext || !DefaultPluginSpec || !StructureElement || !StructureProperties || !LinearAlgebra) {
    throw new MolstarUnavailableError(
      `Mol* 命名空间不完整（PluginContext=${Boolean(PluginContext)} DefaultPluginSpec=${Boolean(DefaultPluginSpec)} ` +
        `StructureElement=${Boolean(StructureElement)} StructureProperties=${Boolean(StructureProperties)} ` +
        `LinearAlgebra=${Boolean(LinearAlgebra)}）`,
    );
  }
  return {
    version: root.version,
    PluginContext,
    DefaultPluginSpec,
    StructureElement,
    StructureProperties,
    LinearAlgebra,
  };
}
