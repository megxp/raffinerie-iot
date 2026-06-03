# Raffinerie IoT — Détection d'anomalies industrielles par IA

**EIGSI IABD S8 — Projet Filière 2026**
**BEDOUME LEGNIGHA Chiara Megane**

Axe choisi : **Métier + IA** — Génération de données réalistes & modèle prédictif intégré dans une pipeline IoT temps réel.

---

## Vue d'ensemble

Ce projet simule une pipeline IoT industrielle complète pour une raffinerie, avec détection automatique d'anomalies par apprentissage automatique. Il modélise une colonne de distillation atmosphérique avec 3 phases d'exploitation physiquement cohérentes, et intègre un modèle GradientBoosting dans Apache Spark Streaming pour détecter les cavitations de pompe en temps réel.

---

## Architecture

```
Simulateur IoT (Python)
        ↓
   MQTT Broker (Mosquitto)
        ↓
  Apache Kafka (buffer)
        ↓
 Spark Streaming (ML + KPI)
        ↓
TimescaleDB ←→ MinIO (stockage brut)
        ↓
   Grafana + Django (visualisation & contrôle)
```

Tous les composants sont conteneurisés via **Docker Compose**.

---

## Fonctionnalités

### Piste 1 — Simulateur réaliste
- **3 phases automatiques** : Démarrage → Stable → Anomalie
- **Démarrage** : montée sigmoïde de 50°C → 340°C (inertie thermique réaliste)
- **Stable** : oscillations autour du setpoint avec bruit gaussien (régulation PID imparfaite)
- **Anomalie** : cavitation de pompe — pic de vibration >4.5 mm/s + chute de pression simultanée
- **4 capteurs corrélés** : température (°C), vibration (mm/s), pression (bar), débit (m³/h)
- Configurable via variable d'environnement `NB_CAPTEURS`

### Piste 2 — Modèle prédictif ML
- Extraction des données historiques depuis **MinIO**
- **Feature engineering** : fenêtres glissantes de 5 mesures (10 secondes d'historique) sur vibration + pression, enrichies de features statistiques (std, max, trend)
- **GradientBoostingClassifier** + StandardScaler dans un Pipeline sklearn
- 27 433 échantillons d'entraînement, 1.2% d'anomalies (ratio industriellement réaliste)
- Seuil optimal trouvé automatiquement via courbe precision-recall : **0.43**
- Résultats : Precision 0.74 / Recall 0.69 / F1 0.72
- Modèle intégré dans **Spark Streaming** — alerte déclenchée à chaque batch si probabilité > seuil

### Interface web Django
- **Start / Stop** pipeline complète (simulateur + MQTT→Kafka + Spark)
- **Slider** nombre de capteurs IoT (1 → 20)
- **Seuils d'alerte** vibration et température configurables en temps réel
- **Alertes ML** affichées avec probabilité et valeurs associées
- **Graphes temps réel** (Chart.js) depuis TimescaleDB
- Config partagée avec Spark via `pipeline_config.json`

---

## Stack technique

| Composant | Technologie |
|---|---|
| Simulateur IoT | Python 3 + paho-mqtt |
| Broker MQTT | Eclipse Mosquitto 2.0 |
| Message queue | Apache Kafka 7.4 |
| Stream processing | Apache Spark 3.4.1 |
| ML | scikit-learn (GradientBoosting) |
| Time series DB | TimescaleDB 2.14 (PostgreSQL 14) |
| Object storage | MinIO |
| Visualisation | Grafana 10.2 |
| Interface web | Django 4.2 + Tailwind CSS + Chart.js |
| Conteneurisation | Docker Compose |

---

## Lancement rapide

### Prérequis
- Docker Desktop
- Python 3.8+
- Node.js (optionnel, pour Tailwind)

### 1. Démarrer l'infrastructure
```bash
cd raffinerie-iot
docker compose up -d
```

### 2. Installer les dépendances Python
```bash
pip install paho-mqtt kafka-python boto3 pandas scikit-learn joblib psycopg2-binary django
```

### 3. Lancer la pipeline
```bash
# Simulateur
python simulateur_capteurs.py &

# Bridge MQTT → Kafka
python mqtt_to_kafka.py &

# Spark Streaming (dans le conteneur)
docker exec spark-master rm -rf /app/data/
docker exec -d spark-master /opt/spark/bin/spark-submit \
  --master local[2] \
  --conf spark.jars.ivy=/tmp/.ivy \
  --packages org.apache.spark:spark-sql-kafka-0-10_2.12:3.4.1,\
org.postgresql:postgresql:42.6.0,\
org.apache.hadoop:hadoop-aws:3.3.1 \
  /app/traitement_kpi.py
```

### 4. Lancer l'interface web
```bash
cd raffinerie_dashboard
export RAFFINERIE_DIR=/chemin/vers/raffinerie-iot
python manage.py runserver
```

Ouvre [http://127.0.0.1:8000](http://127.0.0.1:8000)

### 5. Entraîner le modèle ML
```bash
cd raffinerie-iot
python train_model.py
docker cp modele_vibration.pkl spark-master:/app/modele_vibration.pkl
```

---

## Accès aux services

| Service | URL |
|---|---|
| Interface Django | http://localhost:8000 |
| Grafana | http://localhost:3000 |
| MinIO | http://localhost:9000 |
| Spark UI | http://localhost:8080 |

---

## Structure du projet

```
projet-de-parcours/
├── raffinerie-iot/
│   ├── docker-compose.yml
│   ├── simulateur_capteurs.py   # Simulateur 3 phases physiques
│   ├── mqtt_to_kafka.py         # Bridge MQTT → Kafka
│   ├── traitement_kpi.py        # Spark Streaming + ML + KPI
│   ├── train_model.py           # Entraînement GradientBoosting
│   └── spark/
│       └── traitement_kpi.py
└── raffinerie_dashboard/
    ├── manage.py
    ├── pipeline_config.json     # Config partagée avec Spark
    ├── pipeline/
    │   ├── views.py             # API Django + contrôle pipeline
    │   └── urls.py
    └── templates/
        └── dashboard.html       # Interface Tailwind + Chart.js
```

---

## Réflexion critique

**Ce qui fonctionne** : pipeline complète de bout en bout, données physiquement cohérentes, alertes ML déclenchées en temps réel, interface web opérationnelle.

**Limites** : données simulées (pas collectées sur un vrai système industriel), precision 0.74 (26% de fausses alarmes — acceptable car on optimise le recall en contexte industriel).

**Pistes non explorées** : LSTM pour séries temporelles longues, axe Big Data avec cluster Spark distribué (3 PC), persistance des alertes dans Grafana, réentraînement automatique du modèle.

---

*Projet réalisé dans le cadre du parcours IABD — EIGSI Casablanca — 2026*
