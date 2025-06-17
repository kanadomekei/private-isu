import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const loginCounter = new Counter('successful_logins');
const postCounter = new Counter('successful_posts');
const responseTime = new Trend('response_time', true);

export let options = {
  stages: [
    { duration: '30s', target: 10 },  // ウォームアップ
    { duration: '1m', target: 20 },   // 負荷増加
    { duration: '1m', target: 30 },   // 高負荷維持
    { duration: '30s', target: 0 },   // クールダウン
  ],
  thresholds: {
    http_req_duration: ['p(95)<5000'], // 95%のリクエストが5000ms以内
    http_req_failed: ['rate<0.1'],     // エラー率10%以下
    errors: ['rate<0.1'],
  },
  timeout: '60s', // リクエストタイムアウトを60秒に設定
};

const BASE_URL = 'http://localhost';

// テストユーザーデータ
const users = [
  { username: 'mary', password: 'marymary' },
  { username: 'john', password: 'johnjohn' },
  { username: 'alice', password: 'alicealice' },
];

export default function () {
  // ランダムなユーザーを選択
  const user = users[Math.floor(Math.random() * users.length)];
  
  // セッション開始
  let jar = http.cookieJar();
  
  // 1. トップページアクセス
  let response = http.get(`${BASE_URL}/`);
  check(response, {
    'homepage status is 200': (r) => r.status === 200,
    'homepage has content': (r) => r.body && r.body.includes('Iscogram'),
  }) || errorRate.add(1);
  
  sleep(1);
  
  // 2. ログインページアクセス
  response = http.get(`${BASE_URL}/login`);
  check(response, {
    'login page status is 200': (r) => r.status === 200,
    'login page has form': (r) => r.body && r.body.includes('form'),
  }) || errorRate.add(1);
  
  // 3. ログイン実行
  const loginData = {
    account_name: user.username,
    password: user.password,
  };
  
  response = http.post(`${BASE_URL}/login`, loginData);
  const loginSuccess = check(response, {
    'login successful': (r) => r.status === 302 || r.status === 200,
    'login redirect or success': (r) => r.body && !r.body.includes('アカウント名かパスワードが間違っています'),
  });
  
  if (loginSuccess) {
    loginCounter.add(1);
    
    sleep(1);
    
    // 4. タイムラインアクセス
    response = http.get(`${BASE_URL}/`);
    check(response, {
      'timeline after login status is 200': (r) => r.status === 200,
      'timeline shows posts': (r) => r.body && r.body.includes('post'),
    }) || errorRate.add(1);
    
    sleep(1);
    
    // 5. 投稿ページアクセス
    response = http.get(`${BASE_URL}/`);
    if (response.status === 200) {
      // CSRF トークンを取得（実際のフォームに合わせて調整が必要な場合があります）
      const csrfMatch = response.body.match(/name="csrf_token" value="([^"]+)"/);
      
      if (csrfMatch) {
        // 6. 画像投稿（テスト用の小さな画像データ）
        const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        
        const postData = {
          body: `Test post from k6 load test at ${new Date().toISOString()}`,
          csrf_token: csrfMatch[1],
          file: http.file(Buffer.from(imageData, 'base64'), 'test.png', 'image/png'),
        };
        
        response = http.post(`${BASE_URL}/`, postData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        
        const postSuccess = check(response, {
          'post submission status is 302 or 200': (r) => r.status === 302 || r.status === 200,
        });
        
        if (postSuccess) {
          postCounter.add(1);
        } else {
          errorRate.add(1);
        }
      }
    }
    
    sleep(1);
    
    // 7. ユーザーページアクセス
    response = http.get(`${BASE_URL}/@${user.username}`);
    check(response, {
      'user page status is 200': (r) => r.status === 200,
    }) || errorRate.add(1);
    
    // 8. ログアウト
    response = http.get(`${BASE_URL}/logout`);
    check(response, {
      'logout successful': (r) => r.status === 302 || r.status === 200,
    }) || errorRate.add(1);
  } else {
    errorRate.add(1);
  }
  
  // レスポンス時間を記録
  responseTime.add(response.timings.duration);
  
  sleep(Math.random() * 3 + 1); // 1-4秒のランダムな待機
}

export function handleSummary(data) {
  return {
    'k6-load-test-report.json': JSON.stringify(data, null, 2),
    'k6-load-test-report.html': htmlReport(data),
  };
}

function htmlReport(data) {
  const date = new Date().toISOString();
  return `
<!DOCTYPE html>
<html>
<head>
    <title>K6 Load Test Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f4f4f4; padding: 20px; border-radius: 5px; }
        .metric { margin: 10px 0; padding: 10px; border-left: 4px solid #007cba; }
        .success { border-left-color: #28a745; }
        .warning { border-left-color: #ffc107; }
        .error { border-left-color: #dc3545; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    <div class="header">
        <h1>K6 Load Test Report</h1>
        <p>Generated: ${date}</p>
        <p>Duration: ${Math.round(data.state.testRunDurationMs / 1000)}s</p>
    </div>
    
    <h2>Key Metrics</h2>
    <div class="metric ${data.metrics.http_req_failed.values.rate < 0.05 ? 'success' : 'error'}">
        <strong>Error Rate:</strong> ${(data.metrics.http_req_failed.values.rate * 100).toFixed(2)}%
    </div>
    <div class="metric ${data.metrics.http_req_duration.values['p(95)'] < 1000 ? 'success' : 'warning'}">
        <strong>95th Percentile Response Time:</strong> ${data.metrics.http_req_duration.values['p(95)'].toFixed(2)}ms
    </div>
    <div class="metric">
        <strong>Total Requests:</strong> ${data.metrics.http_reqs.values.count}
    </div>
    <div class="metric">
        <strong>Requests/sec:</strong> ${data.metrics.http_reqs.values.rate.toFixed(2)}
    </div>
    
    <h2>Detailed Metrics</h2>
    <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Average Response Time</td><td>${data.metrics.http_req_duration.values.avg.toFixed(2)}ms</td></tr>
        <tr><td>Median Response Time</td><td>${data.metrics.http_req_duration.values.med.toFixed(2)}ms</td></tr>
        <tr><td>Max Response Time</td><td>${data.metrics.http_req_duration.values.max.toFixed(2)}ms</td></tr>
        <tr><td>Successful Logins</td><td>${data.metrics.successful_logins?.values.count || 0}</td></tr>
        <tr><td>Successful Posts</td><td>${data.metrics.successful_posts?.values.count || 0}</td></tr>
    </table>
</body>
</html>`;
}