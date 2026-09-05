"""VCT Prediction Model V1 命令行入口。"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .backtest import evaluate
from .db import Database
from .ingest import (
    load_teams,
    process_pending,
    read_json,
    read_jsonl,
    record_manual_prediction,
    record_match,
    record_player_forms,
    record_roster_event,
)
from .predictor import predict_match
from .realdata import dataset_summary, import_collection, load_collection, save_collection
from .sources.vlr import collect_vct_history
from .history import import_prediction_archive
from .calibration import calibrate_collection, freeze_database
from .automation import run_daily_automation, today_predictions


def _print(value: Any) -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _maps(value: str | None) -> list[str] | None:
    return [item.strip() for item in value.split(",") if item.strip()] if value else None


def _db(args: argparse.Namespace) -> Database:
    return Database(args.db)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="可解释、可回测的 VCT 比赛预测模型 V1")
    parser.add_argument("--db", default="data/vct.sqlite3", help="SQLite 数据库路径")
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init-db", help="初始化数据库")
    init.add_argument("--config", help="可选模型参数 JSON；默认使用内置参数")
    load = commands.add_parser("load-teams", help="从 JSON 录入或更新队伍")
    load.add_argument("--file", required=True)

    match = commands.add_parser("record-match", help="录入一个 JSON 或一组 JSONL 赛果")
    match.add_argument("--file", required=True)
    match.add_argument("--process", action="store_true", help="录入后立即更新 Rating")

    update = commands.add_parser("update-ratings", help="按时间顺序处理尚未更新的赛果")
    update.add_argument("--match-id")

    predict = commands.add_parser("predict", help="生成并锁定赛前预测")
    predict.add_argument("--team-a", required=True)
    predict.add_argument("--team-b", required=True)
    predict.add_argument("--scheduled-at", required=True)
    predict.add_argument("--event", required=True)
    predict.add_argument("--region", required=True)
    predict.add_argument("--patch")
    predict.add_argument("--format", choices=["bo3", "bo5"], default="bo3")
    predict.add_argument("--map-pool", required=True, help="逗号分隔的中文或英文地图名")
    predict.add_argument("--known-maps", help="已公布的有序比赛地图；逗号分隔")
    predict.add_argument("--international", action="store_true")
    predict.add_argument("--tactical-matchup-a", type=float, default=0.0)
    predict.add_argument("--no-persist", action="store_true")

    roster = commands.add_parser("roster-event", help="登记阵容变化并更新连续性")
    roster.add_argument("--team", required=True)
    roster.add_argument("--effective-at", required=True)
    roster.add_argument("--version", required=True)
    roster.add_argument("--changed-players", type=int, required=True)
    roster.add_argument("--continuity", type=float, required=True)
    roster.add_argument("--note")

    players = commands.add_parser("record-player-forms", help="录入带时间戳的选手状态快照")
    players.add_argument("--file", required=True)

    human = commands.add_parser("import-human", help="导入人工赛前锁定预测 JSON/JSONL")
    human.add_argument("--file", required=True)

    report = commands.add_parser("backtest", help="评估已结算且确实在赛前锁定的预测")
    report.add_argument("--source", default="all", help="all、system、human 或 system_backtest")

    replay = commands.add_parser("replay", help="按历史时间顺序预测再更新，用于滚动回测")
    replay.add_argument("--teams", required=True)
    replay.add_argument("--matches", required=True, help="带 map_pool 的 JSONL")
    replay.add_argument("--human-predictions", help="可选：赛前人工预测 JSONL")

    show = commands.add_parser("show-team", help="查看队伍及逐地图 Rating")
    show.add_argument("--team", required=True)

    sync = commands.add_parser("sync-vlr", help="采集并导入可追溯的 VCT 历史赛果")
    sync.add_argument("--start-year", type=int, default=2024)
    sync.add_argument("--end-year", type=int)
    sync.add_argument("--snapshot-root", default="data/imports/vlr/latest")
    sync.add_argument("--raw-root", default="data/raw/vlr")
    sync.add_argument("--collect-only", action="store_true")

    imported = commands.add_parser("import-vlr", help="导入已保存的标准化 VLR 快照")
    imported.add_argument("--snapshot-root", required=True)

    archive = commands.add_parser("import-history", help="导入此前对话中可证明赛前顺序的人工预测")
    archive.add_argument("--file", default="data/history/our_predictions_2026.json")

    commands.add_parser("data-summary", help="输出真实数据集、来源批次和冲突摘要")

    calibrate = commands.add_parser("calibrate-v1", help="用时间顺序回测校准 V1 参数")
    calibrate.add_argument("--snapshot-root", required=True)
    calibrate.add_argument("--evaluation-start", default="2025-01-01T00:00:00+00:00")
    calibrate.add_argument("--evaluation-end", default="2025-12-31T23:59:59+00:00")
    calibrate.add_argument("--holdout-start", default="2026-01-01T00:00:00+00:00")
    calibrate.add_argument("--holdout-end")
    calibrate.add_argument("--output", default="work/calibration-v1.json")

    freeze = commands.add_parser("freeze-v1", help="用校准参数重建数据库并冻结 V1.0")
    freeze.add_argument("--snapshot-root", required=True)
    freeze.add_argument("--calibration", required=True)
    freeze.add_argument("--history", default="data/history/our_predictions_2026.json")
    freeze.add_argument("--version", default="v1.0.0")
    freeze.add_argument("--training-cutoff", default="2025-12-31T23:59:59+00:00")
    freeze.add_argument("--validation-start", default="2026-01-01T00:00:00+00:00")
    freeze.add_argument("--validation-end", required=True)

    daily = commands.add_parser("daily-run", help="V1.1 自动同步赛程、赛果并锁定未来预测")
    daily.add_argument("--raw-root", default="data/raw/vlr/daily")
    daily.add_argument("--horizon-hours", type=int, default=48)
    daily.add_argument("--trigger-type", choices=["cli", "scheduled_task"], default="cli")

    today = commands.add_parser("today", help="查看未来赛程、自动预测与阻塞原因")
    today.add_argument("--hours", type=int, default=48)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    db = _db(args)
    try:
        if args.command == "init-db":
            db.initialize(read_json(args.config) if args.config else None)
            _print({"ok": True, "database": str(db.path), "message": "数据库已初始化"})
        elif args.command == "load-teams":
            _print({"ok": True, "teams_loaded": load_teams(db, args.file)})
        elif args.command == "record-match":
            records = read_jsonl(args.file) if Path(args.file).suffix.lower() == ".jsonl" else [read_json(args.file)]
            results = [record_match(db, item, process=args.process) for item in records]
            _print({"ok": True, "matches_recorded": len(results), "match_ids": [item["match_id"] for item in results]})
        elif args.command == "update-ratings":
            _print({"ok": True, "processed": process_pending(db, args.match_id)})
        elif args.command == "predict":
            result = predict_match(
                db,
                team_a_id=args.team_a,
                team_b_id=args.team_b,
                scheduled_at=args.scheduled_at,
                event=args.event,
                region=args.region,
                patch=args.patch,
                series_format=args.format,
                map_pool=_maps(args.map_pool) or [],
                known_maps=_maps(args.known_maps),
                is_international=args.international,
                tactical_matchup_a=args.tactical_matchup_a,
                persist=not args.no_persist,
            )
            _print(result)
        elif args.command == "roster-event":
            record_roster_event(
                db,
                team_id=args.team,
                effective_at=args.effective_at,
                roster_version=args.version,
                changed_players=args.changed_players,
                continuity=args.continuity,
                note=args.note,
            )
            _print({"ok": True, "team_id": args.team, "roster_version": args.version})
        elif args.command == "record-player-forms":
            _print({"ok": True, "snapshots_recorded": record_player_forms(db, args.file)})
        elif args.command == "import-human":
            records = read_jsonl(args.file) if Path(args.file).suffix.lower() == ".jsonl" else [read_json(args.file)]
            _print({"ok": True, "prediction_ids": [record_manual_prediction(db, item) for item in records]})
        elif args.command == "backtest":
            _print(evaluate(db, args.source))
        elif args.command == "replay":
            db.initialize()
            team_count = load_teams(db, args.teams)
            if args.human_predictions:
                for item in read_jsonl(args.human_predictions):
                    record_manual_prediction(db, item)
            records = sorted(read_jsonl(args.matches), key=lambda item: (item["played_at"], item["match_id"]))
            for item in records:
                locked_dt = datetime.fromisoformat(item["played_at"].replace("Z", "+00:00")) - timedelta(seconds=1)
                predict_match(
                    db,
                    team_a_id=item["team_a_id"],
                    team_b_id=item["team_b_id"],
                    scheduled_at=item["played_at"],
                    event=item["event"],
                    region=item["region"],
                    patch=item.get("patch"),
                    series_format=item["series_format"],
                    map_pool=item["map_pool"],
                    is_international=bool(item.get("is_international", False)),
                    tactical_matchup_a=float(item.get("tactical_matchup_a", 0.0)),
                    source="system_backtest",
                    locked_at=locked_dt.isoformat(),
                )
                record_match(db, item, process=True)
            _print({"ok": True, "teams": team_count, "matches_replayed": len(records), "metrics": evaluate(db, "all")})
        elif args.command == "show-team":
            team = db.fetch_team(args.team)
            with db.connect() as conn:
                ratings = [dict(row) for row in conn.execute(
                    "SELECT map_id, rating, matches_played, updated_at FROM team_map_ratings WHERE team_id=? ORDER BY map_id",
                    (args.team,),
                ).fetchall()]
            _print({"team": team, "map_ratings": ratings})
        elif args.command == "sync-vlr":
            batch_stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
            raw_root = Path(args.raw_root) / batch_stamp
            collection = collect_vct_history(
                raw_root,
                start_year=args.start_year,
                end_year=args.end_year,
                progress=lambda item: _print({"progress": item}),
            )
            paths = save_collection(collection, args.snapshot_root)
            result = None if args.collect_only else import_collection(
                db,
                collection,
                snapshot_root=paths["root"],
            )
            _print({"ok": True, "snapshot": paths, "import": result})
        elif args.command == "import-vlr":
            collection = load_collection(args.snapshot_root)
            _print({
                "ok": True,
                "import": import_collection(db, collection, snapshot_root=args.snapshot_root),
            })
        elif args.command == "import-history":
            _print({"ok": True, **import_prediction_archive(db, args.file)})
        elif args.command == "data-summary":
            db.initialize()
            _print(dataset_summary(db))
        elif args.command == "calibrate-v1":
            collection = load_collection(args.snapshot_root)
            result = calibrate_collection(
                collection,
                evaluation_start=args.evaluation_start,
                evaluation_end=args.evaluation_end,
                holdout_start=args.holdout_start,
                holdout_end=args.holdout_end,
                work_root=Path(args.output).parent,
                progress=lambda item: _print({"calibration_progress": item}),
            )
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            _print({"ok": True, "output": str(output), "best": result["best_result"], "config": result["best_config"]})
        elif args.command == "freeze-v1":
            collection = load_collection(args.snapshot_root)
            calibration = json.loads(Path(args.calibration).read_text(encoding="utf-8"))
            _print({
                "ok": True,
                **freeze_database(
                    db.path,
                    collection,
                    calibration,
                    archive_path=args.history,
                    snapshot_root=args.snapshot_root,
                    model_version=args.version,
                    training_cutoff=args.training_cutoff,
                    validation_start=args.validation_start,
                    validation_end=args.validation_end,
                ),
            })
        elif args.command == "daily-run":
            _print(run_daily_automation(
                db,
                args.raw_root,
                horizon_hours=max(1, args.horizon_hours),
                trigger_type=args.trigger_type,
            ))
        elif args.command == "today":
            _print(today_predictions(db, hours=max(1, args.hours)))
        return 0
    except (ValueError, KeyError, RuntimeError) as exc:
        _print({"ok": False, "error": str(exc)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
