"""
pipeline/views.py — Contrôle de la pipeline IoT raffinerie
EIGSI IABD S8 2026
"""
import json, math, os, re, signal, subprocess
from django.shortcuts import render
from django.http import JsonResponse
from django.views.decorators.http import require_POST
from django.conf import settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime

CONFIG_PATH = settings.PIPELINE_CONFIG_PATH
PID_FILE    = os.path.join(settings.BASE_DIR, '.pipeline_pids.json')
SPARK_LOGS  = os.environ.get("SPARK_LOGS", os.path.expanduser("~/IABD/4A/projet-de-parcours/raffinerie-iot/spark_logs.txt"))

# ── helpers ─────────────────────────────────────────────

def _load_config():
    defaults = {
        "nb_capteurs": 3,
        "seuil_alerte_vibration": 4.5,
        "seuil_alerte_temperature": 180.0,
        "running": False,
        "started_at": None,
        "demo_rapide": False,
    }
    if os.path.exists(CONFIG_PATH):
        data = json.load(open(CONFIG_PATH))
        for k, v in defaults.items():
            data.setdefault(k, v)
        return data
    return defaults

def _save_config(cfg):
    json.dump(cfg, open(CONFIG_PATH, "w"), indent=2)

def _load_pids():
    return json.load(open(PID_FILE)) if os.path.exists(PID_FILE) else {}

def _save_pids(p):
    json.dump(p, open(PID_FILE, "w"))

def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False

_PROCESS_SCRIPTS = {
    "simulateur": "simulateur_capteurs.py",
    "mqtt_kafka": "mqtt_to_kafka.py",
}


def _process_cmdline(pid):
    try:
        r = subprocess.run(
            ["ps", "-p", str(int(pid)), "-ww", "-o", "args="],
            capture_output=True,
            text=True,
            timeout=3,
        )
        return (r.stdout or "").strip()
    except Exception:
        return ""


def _find_pid_by_script(script_name):
    try:
        r = subprocess.run(
            ["pgrep", "-f", script_name],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if r.returncode != 0:
            return None
        for line in r.stdout.strip().splitlines():
            if line.strip().isdigit():
                return int(line.strip())
    except Exception:
        pass
    return None


def _owns_pipeline_process(pid, name):
    """Vérifie que le PID correspond bien à notre script (évite de tuer un processus tiers)."""
    cmd = _process_cmdline(pid)
    expected = _PROCESS_SCRIPTS.get(name, "")
    return expected and expected in cmd


def _sync_pids(pids):
    """Réaligne les PIDs via pgrep (macOS / processus relancés à la main)."""
    pids = dict(pids)
    for name, script in _PROCESS_SCRIPTS.items():
        found = _find_pid_by_script(script)
        if found and _owns_pipeline_process(found, name):
            pids[name] = found
        elif name in pids and not (
            _alive(pids[name]) and _owns_pipeline_process(pids[name], name)
        ):
            pids.pop(name, None)
    return pids


def _logs_dir():
    d = os.path.join(_raffinerie_dir(), "logs")
    os.makedirs(d, exist_ok=True)
    return d


def _spark_running():
    try:
        r = subprocess.run(
            ["docker", "exec", "spark-master", "pgrep", "-f", "traitement_kpi.py"],
            capture_output=True,
            timeout=10,
        )
        return r.returncode == 0
    except Exception:
        return False


def _stop_process(pid, name):
    """Arrêt ciblé : vérifie la commande puis SIGTERM au groupe de processus."""
    if not pid or not _alive(pid):
        return f"{name} : déjà arrêté"
    if not _owns_pipeline_process(pid, name):
        return (
            f"{name} : PID {pid} ignoré (processus inconnu — "
            f"pas {_PROCESS_SCRIPTS.get(name, '?')})"
        )
    try:
        pgid = os.getpgid(int(pid))
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except Exception:
        try:
            os.kill(int(pid), signal.SIGTERM)
        except Exception as e:
            return f"{name} : {e}"
    return f"✗ {name} arrêté (PID {pid})"


def _stop_spark():
    try:
        subprocess.run(
            [
                "docker", "exec", "spark-master",
                "pkill", "-f", "traitement_kpi.py",
            ],
            capture_output=True,
            timeout=15,
        )
        return "✗ Spark arrêté (conteneur spark-master)"
    except Exception as e:
        return f"Spark : {e}"


def _status(pids):
    pids = _sync_pids(pids)
    st = {"spark": _spark_running()}
    for name in ("simulateur", "mqtt_kafka"):
        pid = pids.get(name)
        st[name] = bool(
            pid and _alive(pid) and _owns_pipeline_process(pid, name)
        )
    return st

def _raffinerie_dir():
    return os.environ.get(
        "RAFFINERIE_DIR",
        "/Users/meganelegnigha/IABD/4A/projet-de-parcours/raffinerie-iot"
    )

def _python():
    """Retourne le Python du venv si disponible, sinon sys.executable."""
    import sys
    base = _raffinerie_dir()
    for p in [
        os.path.join(base, "venv", "bin", "python"),
        os.path.join(base, "venv", "Scripts", "python.exe"),
    ]:
        if os.path.exists(p):
            return p
    return sys.executable


# ── alertes ML (lecture spark_logs.txt) ─────────────────

def _get_alertes(n=10):
    """Retourne les n dernières alertes depuis spark_logs.txt."""
    alertes = []
    if not os.path.exists(SPARK_LOGS):
        return alertes
    try:
        with open(SPARK_LOGS, "r") as f:
            lines = f.readlines()
        current = {}
        for line in lines:
            line = line.strip()
            if "ALERTE ANOMALIE" in line:
                current = {"type": "ANOMALIE"}
            elif "Probabilité" in line and current:
                m = re.search(r"([\d.]+)\s*\(seuil=([\d.]+)\)", line)
                if m:
                    current["proba"] = m.group(1)
                    current["seuil"] = m.group(2)
            elif "Vibration" in line and current:
                m = re.search(r"([\d.]+)\s*mm/s", line)
                if m:
                    current["vibration"] = m.group(1)
            elif "Pression" in line and current:
                m = re.search(r"([\d.]+)\s*bar", line)
                if m:
                    current["pression"] = m.group(1)
                    alertes.append(current)
                    current = {}
        alertes.reverse()
        return alertes[:n]
    except Exception:
        return []


# ── données TimescaleDB pour les graphes ─────────────────

def _db_connect():
    import psycopg2
    return psycopg2.connect(
        host="localhost", port=5433,
        dbname="iotdb", user="admin", password="admin",
    )


def _rows_to_series(rows):
    """Convertit des lignes SQL (timestamp, valeur) en série chronologique."""
    rows = list(rows)
    rows.reverse()
    return [
        {"time": r[0].isoformat() if hasattr(r[0], "isoformat") else str(r[0]), "value": float(r[1])}
        for r in rows
    ]


def _list_machines():
    """Liste des machines présentes en base."""
    try:
        conn = _db_connect()
        cur = conn.cursor()
        cur.execute(
            "SELECT DISTINCT machine_id FROM mesures_filtrees ORDER BY machine_id"
        )
        machines = [r[0] for r in cur.fetchall()]
        conn.close()
        return machines
    except Exception:
        return []


def _parse_since(since_str):
    if not since_str:
        return None
    dt = parse_datetime(since_str)
    if dt is None:
        return None
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_current_timezone())
    return dt


def _latest_db_timestamp():
    """Dernière mesure en base (pour afficher la fraîcheur des graphes)."""
    try:
        conn = _db_connect()
        cur = conn.cursor()
        cur.execute("""
            SELECT GREATEST(
                COALESCE((SELECT MAX(timestamp) FROM mesures_filtrees), '-infinity'::timestamptz),
                COALESCE((SELECT MAX(timestamp) FROM kpi_indicateurs), '-infinity'::timestamptz)
            )
        """)
        row = cur.fetchone()
        conn.close()
        if row and row[0]:
            ts = row[0]
            return ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
    except Exception:
        pass
    return None


def _get_donnees_kpi(type_kpi, limit=60, since=None):
    """KPI Spark : moyenne glissante 1 min (aligné Grafana / kpi_indicateurs)."""
    try:
        conn = _db_connect()
        cur = conn.cursor()
        if since:
            cur.execute("""
                SELECT timestamp, valeur
                FROM kpi_indicateurs
                WHERE type_kpi = %s AND timestamp >= %s
                ORDER BY timestamp DESC
                LIMIT %s
            """, (type_kpi, since, limit))
        else:
            cur.execute("""
                SELECT timestamp, valeur
                FROM kpi_indicateurs
                WHERE type_kpi = %s
                ORDER BY timestamp DESC
                LIMIT %s
            """, (type_kpi, limit))
        rows = cur.fetchall()
        conn.close()
        return _rows_to_series(rows)
    except Exception:
        return []


def _get_donnees_machine(type_capteur, machine_id, limit=120, since=None):
    """Mesures brutes filtrées pour une machine (pas de mélange multi-machines)."""
    try:
        conn = _db_connect()
        cur = conn.cursor()
        if since:
            cur.execute("""
                SELECT timestamp, valeur
                FROM mesures_filtrees
                WHERE type_capteur = %s AND machine_id = %s AND timestamp >= %s
                ORDER BY timestamp DESC
                LIMIT %s
            """, (type_capteur, machine_id, since, limit))
        else:
            cur.execute("""
                SELECT timestamp, valeur
                FROM mesures_filtrees
                WHERE type_capteur = %s AND machine_id = %s
                ORDER BY timestamp DESC
                LIMIT %s
            """, (type_capteur, machine_id, limit))
        rows = cur.fetchall()
        conn.close()
        return _rows_to_series(rows)
    except Exception:
        return []


# ── vues ────────────────────────────────────────────────

def dashboard(request):
    config = _load_config()
    pids   = _load_pids()
    st     = _status(pids)
    config["running"] = any(st.values())
    _save_config(config)
    return render(request, "dashboard.html", {
        "config":      config,
        "config_json": json.dumps(config, indent=2),
        "status":      st,
        "running":     config["running"],
        "grafana_url": "http://localhost:3000",
        "minio_url":   "http://localhost:9000",
        "alertes":     _get_alertes(),
        "machines":    _list_machines(),
    })


def _pipeline_env(config):
    env = {**os.environ, "NB_CAPTEURS": str(config["nb_capteurs"])}
    if config.get("demo_rapide"):
        env["DEMO_RAPIDE"] = "1"
        env["PHASE_INIT"] = "ANOMALIE"
    return env


def _start_component(name, script, base, py, env, pids, msgs):
    """Lance un script Python avec logs fichier pour diagnostiquer les crashs."""
    synced = _sync_pids(pids)
    if synced.get(name) and _status(synced).get(name):
        msgs.append(f"{name} déjà actif (PID {synced[name]})")
        pids[name] = synced[name]
        return

    log_path = os.path.join(_logs_dir(), f"{name}.log")
    log_f = open(log_path, "a", encoding="utf-8")
    log_f.write(f"\n--- démarrage {timezone.now().isoformat()} ---\n")
    log_f.flush()
    p = subprocess.Popen(
        [py, script],
        cwd=base,
        env=env,
        stdout=log_f,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    pids[name] = p.pid
    msgs.append(f"✓ {name} lancé (PID {p.pid}, logs → logs/{name}.log)")


@require_POST
def start_pipeline(request):
    import time

    config = _load_config()
    pids   = _sync_pids(_load_pids())
    msgs   = []
    base   = _raffinerie_dir()
    py     = _python()
    env    = _pipeline_env(config)

    # Prérequis : broker MQTT (sinon le simulateur meurt tout de suite)
    try:
        import socket
        s = socket.create_connection(("localhost", 1883), timeout=2)
        s.close()
    except OSError:
        msgs.append(
            "⚠️ MQTT (port 1883) injoignable — lancez d'abord : "
            "cd raffinerie-iot && docker compose up -d"
        )

    # 1. Simulateur
    _start_component(
        "simulateur", "simulateur_capteurs.py", base, py, env, pids, msgs
    )

    # 2. MQTT → Kafka
    _start_component(
        "mqtt_kafka", "mqtt_to_kafka.py", base, py, env, pids, msgs
    )

    time.sleep(2)
    pids = _sync_pids(pids)
    st = _status(pids)
    for name, label in (
        ("simulateur", "Simulateur"),
        ("mqtt_kafka", "MQTT→Kafka"),
    ):
        if not st.get(name):
            log_hint = os.path.join(_logs_dir(), f"{name}.log")
            msgs.append(
                f"⚠️ {label} INACTIF — voir {log_hint} "
                f"(souvent : pip install paho-mqtt kafka-python ou Docker arrêté)"
            )

    # 3. Spark via docker exec (pas de PID local — suivi via pgrep dans le conteneur)
    if not _spark_running():
        spark_inner = (
            "/opt/spark/bin/spark-submit --master local[2] "
            "--conf spark.jars.ivy=/tmp/.ivy "
            "--packages org.apache.spark:spark-sql-kafka-0-10_2.12:3.4.1,"
            "org.postgresql:postgresql:42.6.0,"
            "org.apache.hadoop:hadoop-aws:3.3.1 "
            "/app/traitement_kpi.py"
        )
        try:
            log_file = open(SPARK_LOGS, "a", encoding="utf-8")
            log_file.write(f"\n--- Spark démarré {timezone.now().isoformat()} ---\n")
            log_file.flush()
            docker_cmd = ["docker", "exec", "-d"]
            if config.get("demo_rapide"):
                docker_cmd.extend(["-e", "ML_WINDOW_SIZE=3"])
            docker_cmd.extend(["spark-master", "bash", "-c", spark_inner])
            subprocess.Popen(
                docker_cmd,
                cwd=base,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            msgs.append("✓ Spark lancé (logs → spark_logs.txt)")
        except Exception as e:
            msgs.append(f"Spark : {e}")
    else:
        msgs.append("Spark déjà actif")

    pids.pop("spark", None)
    _save_pids(pids)
    config["running"] = True
    config["started_at"] = timezone.now().isoformat()
    _save_config(config)
    st = _status(pids)
    if config.get("demo_rapide"):
        msgs.append(
            "Mode démo : phase ANOMALIE dès le départ — alertes ML possibles en ~15–30 s"
        )
    return JsonResponse({
        "success": True,
        "messages": msgs,
        "status": st,
        "config": config,
    })


@require_POST
def stop_pipeline(request):
    pids = _sync_pids(_load_pids())
    msgs = []

    for name in ("simulateur", "mqtt_kafka"):
        pid = pids.get(name)
        if not pid or not _alive(pid):
            found = _find_pid_by_script(_PROCESS_SCRIPTS[name])
            if found and _owns_pipeline_process(found, name):
                pid = found
        if pid:
            msgs.append(_stop_process(pid, name))
        else:
            msgs.append(f"{name} : déjà arrêté")

    if _spark_running():
        msgs.append(_stop_spark())
    else:
        msgs.append("Spark : déjà arrêté")

    _save_pids({})
    config = _load_config()
    config["running"] = False
    config["started_at"] = None
    _save_config(config)
    return JsonResponse({
        "success": True,
        "messages": msgs,
        "status": _status({}),
        "config": config,
    })


def _parse_seuil(body, key, lo, hi, config_key, config, errors):
    if key not in body:
        return
    raw = body[key]
    if raw is None or raw == "":
        errors.append(f"{key}: valeur manquante")
        return
    try:
        v = float(raw)
    except (TypeError, ValueError):
        errors.append(f"{key}: nombre invalide")
        return
    if math.isnan(v) or math.isinf(v):
        errors.append(f"{key}: nombre invalide")
        return
    if not (lo < v <= hi):
        errors.append(f"{key}: {v} hors plage ({lo}, {hi}]")
        return
    config[config_key] = v


@require_POST
def update_config(request):
    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({"success": False, "error": "JSON invalide"}, status=400)

    config = _load_config()
    errors = []

    if "nb_capteurs" in body:
        try:
            v = int(body["nb_capteurs"])
            if 1 <= v <= 20:
                config["nb_capteurs"] = v
            else:
                errors.append("nb_capteurs: doit être entre 1 et 20")
        except (TypeError, ValueError):
            errors.append("nb_capteurs: entier invalide")

    _parse_seuil(
        body, "seuil_vibration", 0, 10,
        "seuil_alerte_vibration", config, errors,
    )
    _parse_seuil(
        body, "seuil_temperature", 0, 400,
        "seuil_alerte_temperature", config, errors,
    )

    if "demo_rapide" in body:
        config["demo_rapide"] = bool(body["demo_rapide"])

    if errors:
        return JsonResponse(
            {"success": False, "error": " ; ".join(errors), "config": config},
            status=400,
        )

    try:
        _save_config(config)
    except OSError as e:
        return JsonResponse(
            {"success": False, "error": f"Impossible d'écrire la config : {e}"},
            status=500,
        )

    return JsonResponse({"success": True, "config": config})


@require_POST
def restart_simulateur(request):
    pids   = _load_pids()
    config = _load_config()
    base   = _raffinerie_dir()
    py     = _python()

    if _alive(pids.get("simulateur", -1)):
        try:
            os.kill(int(pids["simulateur"]), 15)
        except Exception:
            pass

    env = {**os.environ, "NB_CAPTEURS": str(config["nb_capteurs"])}
    p = subprocess.Popen(
        [py, "simulateur_capteurs.py"],
        cwd=base, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    pids["simulateur"] = p.pid
    _save_pids(pids)
    return JsonResponse({
        "success": True,
        "message": f"✓ Simulateur redémarré avec {config['nb_capteurs']} capteurs (PID {p.pid})"
    })


def status_api(request):
    pids   = _sync_pids(_load_pids())
    _save_pids(pids)
    config = _load_config()
    st     = _status(pids)
    return JsonResponse({
        "status":  st,
        "config":  config,
        "running": any(st.values()),
        "alertes": _get_alertes(5),
    })


def donnees_api(request):
    """
    Séries pour les graphes du dashboard.
    - ?since= ISO : uniquement depuis le démarrage de la pipeline (config ou param).
    - Sans ?machine= : KPI 1 min (délai ~1 min pour les nouveaux points).
    - Avec ?machine= : mesures brutes (~2 s) — recommandé pendant une session live.
    """
    machine = request.GET.get("machine", "").strip()
    try:
        limit = min(max(int(request.GET.get("limit", 60)), 10), 300)
    except ValueError:
        limit = 60

    since_str = request.GET.get("since") or _load_config().get("started_at")
    since = _parse_since(since_str)

    machines = _list_machines()
    types = ("temperature", "vibration", "pression", "debit")

    meta = {
        "since": since.isoformat() if since else None,
        "latest_in_db": _latest_db_timestamp(),
        "session_filter": bool(since),
    }

    if machine:
        if machine not in machines:
            return JsonResponse(
                {"error": f"Machine inconnue : {machine}", "machines": machines},
                status=400,
            )
        return JsonResponse({
            "source": "mesures_filtrees",
            "machine": machine,
            "machines": machines,
            **meta,
            **{t: _get_donnees_machine(t, machine, limit, since) for t in types},
        })

    return JsonResponse({
        "source": "kpi_indicateurs",
        "machine": None,
        "machines": machines,
        **meta,
        **{t: _get_donnees_kpi(t, limit, since) for t in types},
    })