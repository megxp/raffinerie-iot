# Raffinerie IoT — Dashboard Django
EIGSI IABD S8 — Projet Filière 2026

## Installation (1 fois)

```bash
cd raffinerie_dashboard
pip install -r requirements.txt
npm install
npm run build:css
```

Après modification du HTML ou des classes Tailwind :

```bash
npm run build:css      # compilation unique
npm run watch:css      # recompilation automatique
```

Fichiers front : `static/css/input.css` → `static/css/dashboard.css`, `static/js/dashboard.js`.

## Lancement

```bash
# Variable d'environnement : chemin vers ton projet raffinerie-iot
# (là où se trouvent simulateur_capteurs.py et mqtt_to_kafka.py)
set RAFFINERIE_DIR=C:\Users\TonNom\raffinerie-iot   # Windows
# ou
export RAFFINERIE_DIR=~/raffinerie-iot              # Linux/Mac

python manage.py runserver
```

Ouvre ensuite http://127.0.0.1:8000

## Fonctionnalités

| Fonctionnalité | Endpoint | Description |
|---|---|---|
| Dashboard principal | GET / | Interface de contrôle complète |
| Démarrer pipeline | POST /api/start/ | Lance simulateur + MQTT→Kafka + Spark |
| Arrêter pipeline | POST /api/stop/ | Arrête tous les processus |
| Mettre à jour config | POST /api/config/ | Modifie nb_capteurs et seuils d'alerte |
| Redémarrer simulateur | POST /api/restart-sim/ | Relance avec le nouveau nb de capteurs |
| Status en temps réel | GET /api/status/ | JSON — état de la pipeline (polling) |

## Intégration avec Spark (Piste 2)

Le fichier `pipeline_config.json` est partagé entre Django et Spark.
Dans `traitement_kpi.py`, lis le seuil dynamiquement à chaque batch :

```python
import json, os

CONFIG_PATH = os.environ.get("PIPELINE_CONFIG_PATH", "./pipeline_config.json")

def get_seuil():
    with open(CONFIG_PATH) as f:
        return json.load(f).get("seuil_alerte_vibration", 4.5)
```

## Adapter RAFFINERIE_DIR

Si le projet raffinerie-iot n'est pas dans le home, modifie la variable
d'environnement RAFFINERIE_DIR avant de lancer `runserver`.
