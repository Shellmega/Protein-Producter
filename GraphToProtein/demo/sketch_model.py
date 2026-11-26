"""Local sketch-to-backbone inference with the project's installed model and geometry adapter."""
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(os.environ.get("GTP_PROJECT_DIR",Path(__file__).resolve().parents[1])).resolve()
sys.path.insert(0, str(ROOT))
from adapters.gtp_curve.graph import validate_source_graph
from adapters.gtp_curve.payload import build_condition_payload, validate_payload
import product_runtime as runtime
from experiments.p3.metrics import geometry_gates, geometry_metrics, kabsch_rigid, parse_pdb

LENGTH = 60
STEPS = 50
CANDIDATES = 4
WEIGHTS_HASH = "0fcf7d7c32b4848030aca3a051e6768de194616f96ba6c38186351a33bfc6eca"


def condition_for(graph):
    parsed = validate_source_graph(graph)
    condition = build_condition_payload(parsed, graph_path="sketch.json", target_length=LENGTH)
    validate_payload(condition)
    return condition


def write_json(path, value):
    data = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return hashlib.sha256(data).hexdigest()


def check_installation():
    for path in (runtime.GPU_PYTHON, runtime.TREE_DSH/"scripts/run_inference.py", runtime.WEIGHTS/"Base_ckpt.pt"):
        if not path.is_file():
            raise RuntimeError(f"这台电脑缺少本地模型组件：{path}")
    if runtime.sha256_file(runtime.WEIGHTS/"Base_ckpt.pt") != WEIGHTS_HASH:
        raise RuntimeError("本地模型权重与项目登记的 Base_ckpt.pt 不符。")


def measure(pdb, condition):
    ca = {}
    atom_count = 0
    for row in pdb.splitlines():
        if not row.startswith("ATOM  "):
            continue
        point = [float(row[i:i+8]) for i in (30, 38, 46)]
        if not all(map(math.isfinite, point)):
            raise ValueError("模型输出有无效坐标")
        atom_count += 1
        if row[12:16].strip() == "CA":
            index = int(row[22:26])
            if index in ca:
                raise ValueError("模型输出有重复的骨架坐标")
            ca[index] = point
    if sorted(ca) != list(range(1, LENGTH+1)):
        raise ValueError("模型未返回完整骨架")
    targets = condition["control_points_angstrom"]
    anchors = []
    for anchor in condition["anchors"]:
        i = anchor["control_point_index"]
        residue = anchor["residue_index0"] + 1
        anchors.append({"point": i+1, "residue": residue, "target": targets[i],
                        "ca": ca[residue], "distance": math.dist(ca[residue], targets[i])})
    # Compare the whole ordered trace in the original model frame, including the two ends.
    path_distances = [anchors[0]["distance"]]
    for left, right in zip(anchors, anchors[1:]):
        for index in range(left["residue"]+1, right["residue"]+1):
            t = (index-left["residue"])/(right["residue"]-left["residue"])
            target = [(1-t)*a+t*b for a,b in zip(left["target"],right["target"])]
            path_distances.append(math.dist(ca[index],target))
    return {"atoms": atom_count, "residues": len(ca), "anchors": anchors,
            "path_mean_distance": sum(path_distances)/len(path_distances),
            "mean_distance": sum(a["distance"] for a in anchors)/len(anchors)}


def score_candidate(path, condition, seed):
    raw = path.read_bytes()
    measured = measure(raw.decode("ascii"), condition)
    residues = parse_pdb(path)
    quality = geometry_metrics(residues, LENGTH)
    if quality["n_chains"] != 1 or [r.resseq for r in residues] != list(range(1, LENGTH+1)):
        raise ValueError("候选含有多条链或不连续的残基编号")
    gates = {g["id"]:g["status"] for g in geometry_gates(quality, LENGTH)}
    spacing = quality["ca_ca_spacing"]
    points = [a["ca"] for a in measured["anchors"]]
    targets = [a["target"] for a in measured["anchors"]]
    if len(points) == 2:
        rigid_error = abs(math.dist(*points)-math.dist(*targets))/2
    else:
        rigid_error = kabsch_rigid(points, targets)["rmsd_angstrom"]
    return {**measured, "seed": seed, "geometry_gates": gates,
            "anchor_rigid_rmsd": rigid_error,
            "chain_break_count": spacing["outlier_count"],
            "ca_spacing_min": spacing["min_angstrom"], "ca_spacing_max": spacing["max_angstrom"],
            "pdb_sha256": hashlib.sha256(raw).hexdigest()}


def choose_candidate(candidates):
    eligible = [c for c in candidates if c.get("geometry_gates") and
                all(status == "PASS" for status in c["geometry_gates"].values())]
    if not eligible:
        raise ValueError("本轮没有通过骨架几何检查的候选")
    # Seed zero is the previous product. Improve anchor fit without degrading
    # the intervening trace whenever that baseline is itself eligible.
    baseline = next((c for c in eligible if c["seed"] == 0), None)
    if baseline is not None:
        eligible = [c for c in eligible if c["path_mean_distance"] <= baseline["path_mean_distance"]
                    and c["anchor_rigid_rmsd"] <= baseline["anchor_rigid_rmsd"]]
    return min(eligible, key=lambda c: (c["mean_distance"], c["path_mean_distance"], c["seed"]))


def generate(graph, work):
    work = Path(work).resolve()
    condition = condition_for(graph)
    work.mkdir(parents=True, exist_ok=False)
    graph_sha = write_json(work/"sketch.json", graph)
    condition_sha = write_json(work/"condition.json", condition)
    candidates_dir = work / "candidates"
    candidates_dir.mkdir()
    # A private, initially empty working directory prevents old designs being reused.
    # Quote Windows paths for Hydra, including installations in directories with spaces.
    args = [str(runtime.GPU_PYTHON), "-B", str(runtime.ENTRY), "--gtp-upstream", str(runtime.TREE_DSH),
            "--gtp-spec", str(work/"condition.json"), "--gtp-run-record", str(work/"invocation.json"), "--",
            "inference.output_prefix="+json.dumps((candidates_dir/"backbone").as_posix()), "inference.model_directory_path="+json.dumps(runtime.WEIGHTS.as_posix()),
            "inference.deterministic=True", "inference.design_startnum=0", f"inference.num_designs={CANDIDATES}",
            "inference.write_trajectory=False", "inference.cautious=False", "hydra.run.dir=hydra",
            f"diffuser.T={STEPS}", f"contigmap.contigs=[{LENGTH}-{LENGTH}]",
            'potentials.guiding_potentials=["type:gtp_curve,weight:1.0,sigma:2.0"]',
            "potentials.guide_scale=10.0", "potentials.guide_decay=constant"]
    env = runtime.child_env()
    env["GTP_DGL_SHIM_DETERMINISTIC"] = "1"
    started = time.monotonic()
    with (work/"model.log").open("wb") as log:
        code = subprocess.run(args, cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT,
                              creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0)).returncode
    if code:
        raise RuntimeError(f"模型运行失败（退出码 {code}），详见 {work/'model.log'}")
    return publish_candidates(work, condition, graph_sha, condition_sha, time.monotonic()-started)


def publish_candidates(work, condition, graph_sha, condition_sha, seconds):
    candidates_dir = work / "candidates"
    candidates = []
    for seed in range(CANDIDATES):
        try:
            candidate = score_candidate(candidates_dir / f"backbone_{seed}.pdb", condition, seed)
        except (FileNotFoundError, ValueError) as error:
            candidate = {"seed": seed, "error": str(error)}
        candidates.append(candidate)
    summary = [{k:v for k,v in c.items() if k != "anchors"} for c in candidates]
    write_json(work/"candidate-scores.json",summary)
    winner = choose_candidate(candidates)
    # Keep the published filename used by both existing frontends and old job records.
    shutil.copyfile(candidates_dir / f"backbone_{winner['seed']}.pdb", work/"backbone_0.pdb")
    result = {"model":"RFdiffusion", "is_real_model_output":True, "steps":STEPS,
              "seconds":round(seconds,2), "graph_sha256":graph_sha,
              "condition_sha256":condition_sha, "weights_sha256":WEIGHTS_HASH,
              "candidate_count":CANDIDATES, "candidate_scores":summary, **winner}
    write_json(work/"result.json", result)
    return result
