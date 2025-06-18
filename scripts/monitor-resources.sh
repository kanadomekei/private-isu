#!/bin/bash

# プロジェクト特化リソース監視スクリプト
# Usage: ./monitor-project-resources.sh [duration_seconds] [output_dir]

DURATION=${1:-60}
OUTPUT_DIR=${2:-"monitoring-reports/$(date +%Y%m%d-%H%M%S)"}

echo "Starting project-focused resource monitoring for ${DURATION} seconds..."
echo "Output directory: ${OUTPUT_DIR}"

# 出力ディレクトリを作成
mkdir -p "${OUTPUT_DIR}"

# バックグラウンドで各種リソース監視を開始
echo "Starting monitoring processes..."

# Docker関連プロセスの詳細監視
(
    echo "=== Project Docker Containers Resource Monitoring ===" > "${OUTPUT_DIR}/docker-detailed.log"
    for i in $(seq 1 $DURATION); do
        echo "=== $(date) ===" >> "${OUTPUT_DIR}/docker-detailed.log"
        docker stats --no-stream --format "table {{.Container}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}" >> "${OUTPUT_DIR}/docker-detailed.log" 2>/dev/null
        echo "" >> "${OUTPUT_DIR}/docker-detailed.log"
        sleep 1
    done
) &
DOCKER_PID=$!


# MySQL関連メトリクス
(
    echo "=== MySQL Container Resource Usage ===" > "${OUTPUT_DIR}/mysql-metrics.log"
    for i in $(seq 1 $DURATION); do
        echo "=== $(date) ===" >> "${OUTPUT_DIR}/mysql-metrics.log"
        
        # MySQLコンテナを特定してリソース使用量を取得
        MYSQL_CONTAINER=$(docker ps --format "{{.Names}}" | grep mysql)
        if [ -n "$MYSQL_CONTAINER" ]; then
            docker stats --no-stream "$MYSQL_CONTAINER" >> "${OUTPUT_DIR}/mysql-metrics.log" 2>/dev/null
        fi
        
        echo "" >> "${OUTPUT_DIR}/mysql-metrics.log"
        sleep 2
    done
) &
MYSQL_PID=$!

# Nginx関連メトリクス
(
    echo "=== Nginx Container Resource Usage ===" > "${OUTPUT_DIR}/nginx-metrics.log"
    for i in $(seq 1 $DURATION); do
        echo "=== $(date) ===" >> "${OUTPUT_DIR}/nginx-metrics.log"
        
        # Nginxコンテナを特定してリソース使用量を取得
        NGINX_CONTAINER=$(docker ps --format "{{.Names}}" | grep nginx)
        if [ -n "$NGINX_CONTAINER" ]; then
            docker stats --no-stream "$NGINX_CONTAINER" >> "${OUTPUT_DIR}/nginx-metrics.log" 2>/dev/null
        fi
        
        echo "" >> "${OUTPUT_DIR}/nginx-metrics.log"
        sleep 2
    done
) &
NGINX_PID=$!

# App関連メトリクス
(
    echo "=== App Container Resource Usage ===" > "${OUTPUT_DIR}/app-metrics.log"
    for i in $(seq 1 $DURATION); do
        echo "=== $(date) ===" >> "${OUTPUT_DIR}/app-metrics.log"
        
        # Appコンテナを特定してリソース使用量を取得
        APP_CONTAINER=$(docker ps --format "{{.Names}}" | grep app)
        if [ -n "$APP_CONTAINER" ]; then
            docker stats --no-stream "$APP_CONTAINER" >> "${OUTPUT_DIR}/app-metrics.log" 2>/dev/null
        fi
        
        echo "" >> "${OUTPUT_DIR}/app-metrics.log"
        sleep 2
    done
) &
APP_PID=$!

# 監視プロセスIDを記録
echo "Monitoring PIDs:"
echo "Docker Detailed: ${DOCKER_PID}"
echo "MySQL Metrics: ${MYSQL_PID}"
echo "Nginx Metrics: ${NGINX_PID}"
echo "App Metrics: ${APP_PID}"

# 監視プロセスの完了を待機
echo "Waiting for monitoring to complete..."

# 指定された時間が経過したら全プロセスを強制終了
sleep $DURATION
echo "Monitoring duration completed. Stopping all monitoring processes..."

# 全監視プロセスを停止
kill ${DOCKER_PID} ${MYSQL_PID} ${NGINX_PID} ${APP_PID} 2>/dev/null

# プロセスの終了を待機（最大3秒）
sleep 3

# まだ残っているプロセスがあれば強制終了
jobs -p | xargs kill -9 2>/dev/null || true

echo "Project resource monitoring completed!"
echo "Reports saved to: ${OUTPUT_DIR}"

# 最終的なDockerサマリーを生成
echo "=== Final Project Summary ===" > "${OUTPUT_DIR}/final-summary.txt"
echo "Monitoring Duration: ${DURATION} seconds" >> "${OUTPUT_DIR}/final-summary.txt"
echo "Timestamp: $(date)" >> "${OUTPUT_DIR}/final-summary.txt"
echo "" >> "${OUTPUT_DIR}/final-summary.txt"

echo "Docker Containers:" >> "${OUTPUT_DIR}/final-summary.txt"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" >> "${OUTPUT_DIR}/final-summary.txt" 2>/dev/null

echo "" >> "${OUTPUT_DIR}/final-summary.txt"
echo "Final Resource Usage:" >> "${OUTPUT_DIR}/final-summary.txt"
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.BlockIO}}" >> "${OUTPUT_DIR}/final-summary.txt" 2>/dev/null

echo "Generated files:" >> "${OUTPUT_DIR}/final-summary.txt"
ls -la "${OUTPUT_DIR}"/*.log >> "${OUTPUT_DIR}/final-summary.txt" 2>/dev/null

echo ""
echo "=== Final Project Summary ==="
cat "${OUTPUT_DIR}/final-summary.txt"