# Console Docker de tests et de benchmarks

Le dossier `tests/` regroupe la validation fonctionnelle et la mesure de performances dans une seule stack reproductible. Il lance :

- un ClickHouse dédié ;
- `chdash_source`, compilé depuis les sources locales en mode Release ;
- `chdash_release`, démarré depuis la release versionnée la plus élevée de `tests/releases/` ;
- un runner Python unique qui exécute les tests, produit les rapports et sert l'interface web.

## Démarrage

Depuis ce dossier :

```bash
docker compose up -d --build
```

Interfaces :

```text
Console qualité    : http://localhost:18082
Dashboard source   : http://localhost:18080
Dashboard release  : http://localhost:18081
ClickHouse HTTP    : http://localhost:18123
ClickHouse TCP     : localhost:19000
```

Suivi du runner :

```bash
docker compose logs -f tests
```

Arrêt et nettoyage complet :

```bash
docker compose down -v --remove-orphans
```

## Interface web

La console possède deux vues indépendantes :

- **Tests** : synthèse JUnit, auto-tests du harness, cas en échec, diagnostic différentiel source/release des types natifs, diff attendu/obtenu du formatage SQL et log pytest ;
- **Benchmark** : source vs release, plancher ClickHouse HTTP direct, intégrité des lignes/types/events SSE et log du runner.

Chaque vue possède son propre bouton de relance et son bouton **Télécharger le rapport ZIP**. Le ZIP est autonome et contient tous les artefacts du run ainsi qu'un `report-manifest.json` compact, prévu pour une analyse automatique ou pour être transmis tel quel.

L'interface ne remplace plus les tableaux lors d'une simple mise à jour d'état : leurs scrollbars horizontales et verticales restent en place. L'état est poussé par Server-Sent Events uniquement lorsqu'il change. Les logs sont lus par blocs incrémentaux et le détail d'un diff SQL n'est calculé qu'à l'ouverture du cas.

## Exécution automatique

Par défaut, les tests API sont lancés au démarrage du runner. Un échec de test ne termine pas le conteneur web : le résultat reste consultable et les boutons permettent une nouvelle exécution.

```bash
# Aucun lancement automatique
TEST_RUNNER_AUTO_TESTS=0 docker compose up -d --build

# Tests puis benchmark au démarrage
TEST_RUNNER_AUTO_BENCHMARK=1 docker compose up -d --build
```

## Releases comparées

Dépose autant d'archives versionnées que nécessaire dans :

```text
tests/releases/
```

Exemple :

```text
chdash_2.8.0_linux_amd64.tar.gz
chdash_2.8.1_linux_amd64.tar.gz
chdash_2.8.2_linux_amd64.tar.gz
```

Le conteneur `chdash_release` choisit automatiquement la version la plus élevée présente dans le nom du fichier.

## Diagnostic des tests de types natifs

Les requêtes `AggregateFunction`, `JSON` et entiers larges sont toujours validées sur le binaire source. Lorsqu'un cas échoue, le runner rejoue automatiquement la même requête sur la release sélectionnée afin de distinguer :

- une régression du binaire source si la release réussit ;
- une limitation partagée par la source et la release ;
- une erreur de transport ou d'infrastructure du harness.

Le test reste en échec lorsqu'il révèle un problème du binaire : le runner ne masque pas une régression produit pour rendre la suite verte. Le diagnostic détaillé, avec tokens sensibles expurgés, est écrit dans :

```text
tests/artifacts/tests/<run>/query_types_results.json
```

Le runner exécute aussi des auto-tests locaux du benchmark avant les tests API. Ils couvrent notamment les réponses HTTP ClickHouse `Transfer-Encoding: chunked`, les réponses `Content-Length`, les coupures au milieu d'un caractère UTF-8 et le parsing des hosts HCL commentés.

## Benchmark

Chaque requête est exécutée par trois chemins :

```text
source       -> API chdash compilée localement + flux SSE
release      -> API chdash de la release sélectionnée + flux SSE
http_direct  -> ClickHouse HTTP + JSONCompactEachRowWithNamesAndTypes
```

Les trois chemins réutilisent leurs connexions HTTP entre les warmups et les runs mesurés. Le chemin HTTP direct télécharge le résultat complet et mesure les headers, le premier octet, la première ligne et la fin de réponse. Il sert de plancher réaliste : le coût de sérialisation et de transfert n'est pas masqué par un `FORMAT Null`, et le benchmark ne mesure pas artificiellement un nouveau handshake à chaque requête.

Les comparaisons vérifient notamment :

- le hash et le nombre de lignes ;
- la signature noms/types des colonnes ;
- les events SSE obligatoires et leur présence ;
- le nombre d'events, lorsqu'un contrôle strict est demandé ;
- le statut `done`, les erreurs et la cohérence des compteurs ;
- l'overhead de chaque dashboard au-dessus de ClickHouse HTTP direct.

Réglages usuels :

```bash
BENCH_RUNS=10 BENCH_WARMUP=2 docker compose up -d --build
BENCH_DISABLE_DIRECT_HTTP=1 docker compose up -d --build
BENCH_STRICT_EVENT_COUNTS=1 docker compose up -d --build
```

Le CSV spécifique au plancher HTTP est écrit dans :

```text
tests/artifacts/benchmark/<run>/direct_http_overhead.csv
```

## Instance distante active

Ajoute un vrai bloc `host` dans `tests/config/CH_HOSTS.hcl`, puis expose son endpoint HTTP au benchmark direct avec le même identifiant :

```hcl
host {
  name       = "active"
  runner_uri = "clickhouse://user:password@clickhouse-active.example.com:9000"
  system_uri = "clickhouse://user:password@clickhouse-active.example.com:9000"
}
```

```bash
BENCH_HOST_IDS="local,active" \
BENCH_CLICKHOUSE_HTTP_TARGETS="local=http://clickhouse:8123,active=https://user:password@clickhouse-active.example.com:8443" \
docker compose up -d --build
```

## Artefacts et rapports ZIP

Tous les runs sont conservés sous :

```text
tests/artifacts/tests/<run>/
tests/artifacts/benchmark/<run>/
```

Le rapport ZIP est construit uniquement lors du premier téléchargement, puis mis en cache tant que les fichiers du run ne changent pas. Il contient :

```text
README.txt
report-manifest.json
runner-result.json
junit.xml / format_results.json / query_types_results.json / format_failures/*
comparison.md / summary.json / *.csv / runs.jsonl / events/*
logs complets
```

Le cache des rapports se trouve dans `tests/artifacts/.reports/` et peut être supprimé sans perdre les résultats sources.

## Réglages d'overhead du runner

```bash
# Quantité initiale de log chargée et blocs incrémentaux
TEST_RUNNER_LOG_INITIAL_BYTES=131072
TEST_RUNNER_LOG_CHUNK_BYTES=65536

# Rétention en disque et historique envoyé à l'interface
TEST_RUNNER_MAX_RUNS=30
TEST_RUNNER_MAX_HISTORY=30

# Pagination/lazy loading des diffs SQL
TEST_RUNNER_FORMAT_PAGE_SIZE=20
TEST_RUNNER_FORMAT_MAX_DIFF_ROWS=1800

# Compression des réponses JSON volumineuses et des rapports à la demande
TEST_RUNNER_JSON_GZIP_MIN_BYTES=4096
TEST_RUNNER_JSON_GZIP_LEVEL=3
TEST_RUNNER_REPORT_COMPRESSION_LEVEL=3

# Fréquence de heartbeat SSE et silence des access logs du polling
TEST_RUNNER_SSE_HEARTBEAT_SECONDS=15
TEST_RUNNER_QUIET_ACCESS_LOGS=1

# Écrit le manifeste de formatage tous les N succès ; un échec est écrit immédiatement
FORMAT_RESULTS_FLUSH_EVERY=20

# Compression modérée des traces du benchmark, hors fenêtre chronométrée
BENCH_TRACE_COMPRESSION_LEVEL=3
```

Les healthchecks utilisent `/api/health`, qui ne déclenche ni parsing de rapport ni parcours récursif des artefacts. L'état complet n'est demandé qu'après une notification SSE ou lors du polling de secours. Les détails benchmark, les listes d'artefacts et les diffs SQL sont chargés séparément et mis en cache avec `ETag`.

Pendant l’exécution, `runs.partial.jsonl` est alimenté en append après chaque mesure au lieu d’être réécrit intégralement ; à la fin d’une exécution complète, il est renommé atomiquement en `runs.jsonl`, même si les validations signalent ensuite une régression. Il reste en place uniquement si le processus est réellement interrompu avant la production du rapport. Les traces JSON gzip utilisent un niveau de compression modéré et un encodage compact afin que la génération des artefacts ne perturbe pas les temps mesurés.
