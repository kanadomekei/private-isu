# Private ISU 高速化実装ガイド

## 前提条件
- 分析により特定されたボトルネック: データベースのインデックス不足とN+1問題
- 現在のスコア: 0点、多数のタイムアウトエラー

## Phase 1: 緊急対応（インデックス追加）

### 1.1 MySQLに接続
```bash
docker compose -f webapp/docker-compose.yml exec mysql mysql -h127.0.0.1 -uroot -proot isuconp
```

### 1.2 必要なインデックスを追加
```sql
-- commentsテーブルの最適化（最重要）
ALTER TABLE comments ADD INDEX idx_post_id (post_id);
ALTER TABLE comments ADD INDEX idx_user_id (user_id);
ALTER TABLE comments ADD INDEX idx_post_id_created_at (post_id, created_at DESC);

-- postsテーブルの最適化
ALTER TABLE posts ADD INDEX idx_created_at (created_at DESC);
ALTER TABLE posts ADD INDEX idx_user_id (user_id);
ALTER TABLE posts ADD INDEX idx_user_id_created_at (user_id, created_at DESC);

-- usersテーブルの最適化
ALTER TABLE users ADD INDEX idx_account_name (account_name);
ALTER TABLE users ADD INDEX idx_del_flg (del_flg);
ALTER TABLE users ADD INDEX idx_authority_del_flg (authority, del_flg);
```

### 1.3 インデックス確認
```sql
SHOW INDEX FROM comments;
SHOW INDEX FROM posts;
SHOW INDEX FROM users;
```

## Phase 2: N+1問題の解決

### 2.1 makePosts関数の最適化

現在の問題コード（app.go:175-224）:
```go
func makePosts(results []Post, csrfToken string, allComments bool) ([]Post, error) {
    var posts []Post
    for _, p := range results {
        // 各投稿ごとにコメント数を取得（N+1問題）
        err := db.Get(&p.CommentCount, "SELECT COUNT(*) AS `count` FROM `comments` WHERE `post_id` = ?", p.ID)
        
        // 各投稿ごとにコメントを取得（N+1問題）
        query := "SELECT * FROM `comments` WHERE `post_id` = ? ORDER BY `created_at` DESC"
        if !allComments {
            query += " LIMIT 3"
        }
        var comments []Comment
        err = db.Select(&comments, query, p.ID)
        
        // 各コメントごとにユーザー情報を取得（N+1問題）
        for i := range comments {
            err := db.Get(&comments[i].User, "SELECT * FROM `users` WHERE `id` = ?", comments[i].UserID)
        }
        
        // 各投稿ごとにユーザー情報を取得（N+1問題）
        err = db.Get(&p.User, "SELECT * FROM `users` WHERE `id` = ?", p.UserID)
    }
}
```

### 2.2 最適化されたコード

```go
func makePosts(results []Post, csrfToken string, allComments bool) ([]Post, error) {
    if len(results) == 0 {
        return []Post{}, nil
    }

    var posts []Post
    postIDs := make([]int, 0, len(results))
    userIDs := make([]int, 0)
    userMap := make(map[int]User)
    
    // 投稿IDとユーザーIDを収集
    for _, p := range results {
        postIDs = append(postIDs, p.ID)
        userIDs = append(userIDs, p.UserID)
    }
    
    // ユーザー情報を一括取得
    users := []User{}
    query := "SELECT * FROM users WHERE id IN (?" + strings.Repeat(",?", len(userIDs)-1) + ")"
    args := make([]interface{}, len(userIDs))
    for i, id := range userIDs {
        args[i] = id
    }
    err := db.Select(&users, query, args...)
    if err != nil {
        return nil, err
    }
    
    // ユーザーマップ作成
    for _, user := range users {
        userMap[user.ID] = user
    }
    
    // コメント数を一括取得
    commentCounts := []struct {
        PostID int `db:"post_id"`
        Count  int `db:"count"`
    }{}
    query = "SELECT post_id, COUNT(*) as count FROM comments WHERE post_id IN (?" + strings.Repeat(",?", len(postIDs)-1) + ") GROUP BY post_id"
    args = make([]interface{}, len(postIDs))
    for i, id := range postIDs {
        args[i] = id
    }
    err = db.Select(&commentCounts, query, args...)
    if err != nil {
        return nil, err
    }
    
    commentCountMap := make(map[int]int)
    for _, cc := range commentCounts {
        commentCountMap[cc.PostID] = cc.Count
    }
    
    // コメントを一括取得
    limitClause := ""
    if !allComments {
        limitClause = " LIMIT 3"
    }
    
    comments := []Comment{}
    query = `SELECT c.*, u.id as user_id, u.account_name, u.passhash, u.authority, u.del_flg, u.created_at as user_created_at
             FROM comments c 
             JOIN users u ON c.user_id = u.id 
             WHERE c.post_id IN (` + strings.Repeat("?,", len(postIDs)-1) + "?) 
             ORDER BY c.post_id, c.created_at DESC"
    
    err = db.Select(&comments, query, args...)
    if err != nil {
        return nil, err
    }
    
    // コメントをグループ化
    commentMap := make(map[int][]Comment)
    for _, comment := range comments {
        commentMap[comment.PostID] = append(commentMap[comment.PostID], comment)
    }
    
    // 投稿データを構築
    for _, p := range results {
        user, exists := userMap[p.UserID]
        if !exists || user.DelFlg == 1 {
            continue
        }
        
        p.User = user
        p.CommentCount = commentCountMap[p.ID]
        p.Comments = commentMap[p.ID]
        p.CSRFToken = csrfToken
        
        // コメントの順序を逆転（最新を最後に）
        if !allComments && len(p.Comments) > 0 {
            for i, j := 0, len(p.Comments)-1; i < j; i, j = i+1, j-1 {
                p.Comments[i], p.Comments[j] = p.Comments[j], p.Comments[i]
            }
            if len(p.Comments) > 3 {
                p.Comments = p.Comments[:3]
            }
        }
        
        posts = append(posts, p)
        if len(posts) >= postsPerPage {
            break
        }
    }
    
    return posts, nil
}
```

## Phase 3: キャッシング戦略

### 3.1 ユーザー情報キャッシュ

```go
// ユーザー情報をキャッシュから取得
func getUserWithCache(userID int) (User, error) {
    cacheKey := fmt.Sprintf("user:%d", userID)
    
    // Memcachedから取得を試行
    if cached, err := memcacheClient.Get(cacheKey); err == nil {
        var user User
        if err := json.Unmarshal(cached.Value, &user); err == nil {
            return user, nil
        }
    }
    
    // キャッシュにない場合はDBから取得
    var user User
    err := db.Get(&user, "SELECT * FROM users WHERE id = ?", userID)
    if err != nil {
        return User{}, err
    }
    
    // Memcachedに保存（1時間）
    if data, err := json.Marshal(user); err == nil {
        memcacheClient.Set(&memcache.Item{
            Key:        cacheKey,
            Value:      data,
            Expiration: 3600,
        })
    }
    
    return user, nil
}
```

### 3.2 投稿一覧キャッシュ

```go
func getIndexPosts(csrfToken string) ([]Post, error) {
    cacheKey := "posts:index"
    
    // Memcachedから取得を試行
    if cached, err := memcacheClient.Get(cacheKey); err == nil {
        var posts []Post
        if err := json.Unmarshal(cached.Value, &posts); err == nil {
            // CSRFトークンを更新
            for i := range posts {
                posts[i].CSRFToken = csrfToken
            }
            return posts, nil
        }
    }
    
    // キャッシュにない場合は通常の処理
    results := []Post{}
    err := db.Select(&results, "SELECT `id`, `user_id`, `body`, `mime`, `created_at` FROM `posts` ORDER BY `created_at` DESC")
    if err != nil {
        return nil, err
    }
    
    posts, err := makePosts(results, csrfToken, false)
    if err != nil {
        return nil, err
    }
    
    // Memcachedに保存（5分）
    if data, err := json.Marshal(posts); err == nil {
        memcacheClient.Set(&memcache.Item{
            Key:        cacheKey,
            Value:      data,
            Expiration: 300,
        })
    }
    
    return posts, nil
}
```

## Phase 4: 画像配信最適化

### 4.1 画像ファイルの事前展開

```bash
# 画像展開スクリプト
#!/bin/bash
mysql -h127.0.0.1 -uroot -proot isuconp -e "
SELECT id, mime, imgdata FROM posts 
" | while IFS=$'\t' read -r id mime imgdata; do
    if [ "$mime" = "image/jpeg" ]; then
        ext=".jpg"
    elif [ "$mime" = "image/png" ]; then
        ext=".png"
    elif [ "$mime" = "image/gif" ]; then
        ext=".gif"
    else
        continue
    fi
    
    echo "$imgdata" | xxd -r -p > "/tmp/images/${id}${ext}"
done
```

### 4.2 Nginx設定更新

```nginx
location ~ ^/image/(\d+)\.(jpg|png|gif)$ {
    root /tmp/images;
    try_files /$1.$2 @app;
    expires 7d;
    add_header Cache-Control "public, immutable";
}

location @app {
    proxy_pass http://app;
}
```

## Phase 5: 検証と監視

### 5.1 パフォーマンステスト実行

```bash
# ベンチマーク実行
task bench:monitor

# 結果確認
cat benchmark-results.txt
```

### 5.2 期待される改善結果

- **スコア**: 0 → 2000-5000+
- **レスポンス時間**: 8秒 → 100-300ms
- **データベース負荷**: 104% → 20-30%
- **タイムアウトエラー**: 65件 → 0件

### 5.3 継続的監視

```bash
# 継続的な監視スクリプト
watch -n 5 'docker stats --no-stream'

# スロークエリログの監視
tail -f webapp/logs/mysql/slow.log
```

## 実装時の注意点

1. **バックアップ**: 変更前に必ずデータベースのバックアップを取る
2. **段階的実装**: Phase 1から順番に実装し、各段階で効果を確認
3. **ロールバック計画**: 問題が発生した場合の復旧手順を準備
4. **監視**: 各変更後にリソース使用量とエラーログを確認

このガイドに従って実装することで、大幅なパフォーマンス向上が期待できます。