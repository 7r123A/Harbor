use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::identity::{db, import, pack, IdentityState};

const FRESH_FOR_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub id: String,
    pub entry: Option<i64>,
    pub title: Option<String>,
    pub provisional: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRef {
    pub scheme: String,
    pub id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedRef {
    pub entry: i64,
    pub title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRef {
    pub anidb: Option<i64>,
    pub tvdb: Option<i64>,
    pub tmdbtv: Option<i64>,
    pub tvdb_season: Option<i64>,
    pub tvdb_offset: Option<i64>,
    pub tmdb_season: Option<i64>,
    pub tmdb_offset: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryBundle {
    pub entry: i64,
    pub title: Option<String>,
    pub media_type: Option<String>,
    pub episodes: Option<i64>,
    pub aliases: Vec<AliasRef>,
    pub related: Vec<RelatedRef>,
    pub windows: Vec<WindowRef>,
}

fn split_key(raw: &str) -> Option<(&str, &str)> {
    let (scheme, id) = raw.split_once(':')?;
    if scheme.is_empty() || id.is_empty() {
        None
    } else {
        Some((scheme, id))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn identity_status(
    app: AppHandle,
    state: State<'_, IdentityState>,
) -> Result<db::IdentityStatus, String> {
    if let Ok(guard) = state.conn.lock() {
        if let Some(conn) = guard.as_ref() {
            return db::status(&app, Some(conn));
        }
    }
    db::status(&app, None)
}

#[tauri::command]
pub async fn identity_ensure_pack(
    app: AppHandle,
    state: State<'_, IdentityState>,
    force: Option<bool>,
) -> Result<db::IdentityStatus, String> {
    let _import = state.import.lock().await;
    let force = force.unwrap_or(false);
    if !force {
        if let Ok(status) = db::status(&app, None) {
            if status.ready && status.schema == db::SCHEMA_VERSION {
                let fresh = status
                    .built_at
                    .map(|built| now_ms() - built < FRESH_FOR_MS)
                    .unwrap_or(false);
                if fresh {
                    return Ok(status);
                }
            }
        }
    }

    let downloaded = pack::download_latest().await?;
    let windows_xml = pack::download_anime_lists().await.ok();
    let tmp = db::tmp_path(&app)?;
    db::ensure_dir(&app)?;
    if tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
    }

    let import_tmp = tmp.clone();
    let version = downloaded.version.clone();
    let sha256 = downloaded.sha256.clone();
    let bytes = downloaded.bytes;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut conn = rusqlite::Connection::open(&import_tmp)
            .map_err(|error| format!("identity import: open tmp: {error}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;",
        )
        .map_err(|error| format!("identity import: pragmas: {error}"))?;
        let reader = pack::decode_zstd(&bytes)?;
        import::import_jsonl(&mut conn, reader, &version, &sha256, now_ms())?;
        match windows_xml {
            Some(xml) => {
                import::import_windows(&mut conn, &xml)?;
            }
            None => eprintln!("[harbor::identity] Anime-Lists windows unavailable; continuing without windows"),
        }
        drop(conn);
        Ok(())
    })
    .await
    .map_err(|error| format!("identity import: task: {error}"))??;

    // Hold the connection lock across the swap so no query keeps the old file open.
    {
        let mut guard = state
            .conn
            .lock()
            .map_err(|_| "identity: db lock poisoned".to_string())?;
        *guard = None;
        db::install_new_db(&app, &tmp)?;
    }
    db::status(&app, None)
}

#[tauri::command]
pub fn identity_lookup_batch(
    app: AppHandle,
    state: State<'_, IdentityState>,
    ids: Vec<String>,
) -> Result<Vec<LookupResult>, String> {
    db::with_conn(&app, &*state, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT i.entry, e.title
                 FROM identities i
                 LEFT JOIN entries e ON e.entry = i.entry
                 WHERE i.scheme = ?1 AND i.id = ?2",
            )
            .map_err(|error| format!("identity lookup: prepare: {error}"))?;
        let mut out = Vec::with_capacity(ids.len());
        for raw in ids {
            let Some((scheme, id)) = split_key(&raw) else {
                out.push(LookupResult {
                    id: raw,
                    entry: None,
                    title: None,
                    provisional: true,
                });
                continue;
            };
            let Some(scheme_code) = import::scheme_code(scheme) else {
                out.push(LookupResult {
                    id: raw,
                    entry: None,
                    title: None,
                    provisional: true,
                });
                continue;
            };
            match stmt.query_row(params![scheme_code, id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
            }) {
                Ok((entry, title)) => out.push(LookupResult {
                    id: raw,
                    entry: Some(entry),
                    title,
                    provisional: false,
                }),
                Err(rusqlite::Error::QueryReturnedNoRows) => out.push(LookupResult {
                    id: raw,
                    entry: None,
                    title: None,
                    provisional: true,
                }),
                Err(error) => return Err(format!("identity lookup: query: {error}")),
            }
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn identity_entry_bundle(
    app: AppHandle,
    state: State<'_, IdentityState>,
    key: String,
) -> Result<Option<EntryBundle>, String> {
    let Some((scheme, id)) = split_key(&key) else {
        return Ok(None);
    };
    let Some(scheme_code) = import::scheme_code(scheme) else {
        return Ok(None);
    };
    db::with_conn(&app, &*state, |conn| {
        let entry: Option<i64> = match conn.query_row(
            "SELECT entry FROM identities WHERE scheme = ?1 AND id = ?2",
            params![scheme_code, id],
            |row| row.get(0),
        ) {
            Ok(entry) => Some(entry),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(error) => return Err(format!("identity bundle: identity: {error}")),
        };
        let Some(entry) = entry else {
            return Ok(None);
        };

        let (title, media_type, episodes): (Option<String>, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT title, type, episodes FROM entries WHERE entry = ?1",
                params![entry],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| format!("identity bundle: entry: {error}"))?;

        let mut alias_stmt = conn
            .prepare("SELECT scheme, id FROM identities WHERE entry = ?1 ORDER BY scheme, id")
            .map_err(|error| format!("identity bundle: aliases: {error}"))?;
        let aliases = alias_stmt
            .query_map(params![entry], |row| {
                let code: i64 = row.get(0)?;
                Ok(AliasRef {
                    scheme: import::scheme_name(code).to_string(),
                    id: row.get(1)?,
                })
            })
            .map_err(|error| format!("identity bundle: aliases query: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("identity bundle: aliases rows: {error}"))?;

        let related_blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT related_blob FROM related WHERE entry = ?1",
                params![entry],
                |row| row.get(0),
            )
            .ok();
        let related_ids = related_blob
            .as_deref()
            .map(import::decode_ids)
            .unwrap_or_default();
        let mut title_stmt = conn
            .prepare("SELECT entry, title FROM entries WHERE entry = ?1")
            .map_err(|error| format!("identity bundle: related titles: {error}"))?;
        let mut related = Vec::with_capacity(related_ids.len());
        for related_entry in related_ids {
            let related_title = title_stmt
                .query_row(params![related_entry], |row| row.get::<_, Option<String>>(1))
                .ok()
                .flatten();
            related.push(RelatedRef {
                entry: related_entry,
                title: related_title,
            });
        }

        let mut window_stmt = conn
            .prepare(
                "SELECT anidb, tvdb, tmdbtv, tvdb_season, tvdb_offset, tmdb_season, tmdb_offset
                 FROM windows WHERE entry = ?1",
            )
            .map_err(|error| format!("identity bundle: windows: {error}"))?;
        let windows = window_stmt
            .query_map(params![entry], |row| {
                Ok(WindowRef {
                    anidb: row.get(0)?,
                    tvdb: row.get(1)?,
                    tmdbtv: row.get(2)?,
                    tvdb_season: row.get(3)?,
                    tvdb_offset: row.get(4)?,
                    tmdb_season: row.get(5)?,
                    tmdb_offset: row.get(6)?,
                })
            })
            .map_err(|error| format!("identity bundle: windows query: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("identity bundle: windows rows: {error}"))?;

        Ok(Some(EntryBundle {
            entry,
            title,
            media_type,
            episodes,
            aliases,
            related,
            windows,
        }))
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardHint {
    pub id: String,
    pub entry: Option<i64>,
    pub title: Option<String>,
    pub media_type: Option<String>,
    pub card_key: Option<String>,
    pub tvdb: Option<i64>,
    pub tmdb: Option<i64>,
    pub season: Option<i64>,
    pub offset: Option<i64>,
    pub provisional: bool,
}

/// Resolve row ids to a provider-show card key. The frontend combines this with
/// its existing catalog-to-entry mapping; missing data is provisional, not an error.
#[tauri::command]
pub fn identity_card_hints(
    app: AppHandle,
    state: State<'_, IdentityState>,
    ids: Vec<String>,
) -> Result<Vec<CardHint>, String> {
    db::with_conn(&app, &*state, |conn| {
        let mut identity = conn
            .prepare(
                "SELECT i.entry, e.title, e.type FROM identities i
                 LEFT JOIN entries e ON e.entry = i.entry
                 WHERE i.scheme = ?1 AND i.id = ?2",
            )
            .map_err(|error| format!("identity cards: prepare identity: {error}"))?;
        let mut window = conn
            .prepare(
                "SELECT tvdb, tmdbtv, tvdb_season, tvdb_offset FROM windows
                 WHERE entry = ?1 AND (tvdb IS NOT NULL OR tmdbtv IS NOT NULL)
                 ORDER BY CASE WHEN tvdb IS NOT NULL THEN 0 ELSE 1 END,
                          CASE WHEN tvdb_season IS NULL OR tvdb_season = 0 THEN 1 ELSE 0 END,
                          tvdb_season ASC
                 LIMIT 1",
            )
            .map_err(|error| format!("identity cards: prepare window: {error}"))?;
        let mut out = Vec::with_capacity(ids.len());
        for raw in ids {
            let Some((scheme, id)) = split_key(&raw) else {
                out.push(CardHint {
                    id: raw,
                    entry: None,
                    title: None,
                    media_type: None,
                    card_key: None,
                    tvdb: None,
                    tmdb: None,
                    season: None,
                    offset: None,
                    provisional: true,
                });
                continue;
            };
            let Some(code) = import::scheme_code(scheme) else {
                out.push(CardHint {
                    id: raw,
                    entry: None,
                    title: None,
                    media_type: None,
                    card_key: None,
                    tvdb: None,
                    tmdb: None,
                    season: None,
                    offset: None,
                    provisional: true,
                });
                continue;
            };
            let resolved = identity
                .query_row(params![code, id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .ok();
            let Some((entry, title, media_type)) = resolved else {
                out.push(CardHint {
                    id: raw,
                    entry: None,
                    title: None,
                    media_type: None,
                    card_key: None,
                    tvdb: None,
                    tmdb: None,
                    season: None,
                    offset: None,
                    provisional: true,
                });
                continue;
            };
            let hint = window
                .query_row(params![entry], |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                })
                .ok();
            let (tvdb, tmdb, season, offset) = match hint {
                Some((tvdb, tmdb, season, offset)) => (tvdb, tmdb, season, offset),
                None => (None, None, None, None),
            };
            let card_key = match (tvdb, tmdb) {
                (Some(tvdb), _) => Some(format!("tvdb:{tvdb}")),
                (None, Some(tmdb)) => Some(format!("tmdb:tv:{tmdb}")),
                _ => None,
            };
            out.push(CardHint {
                id: raw,
                entry: Some(entry),
                title,
                media_type,
                card_key,
                tvdb,
                tmdb,
                season,
                offset,
                provisional: false,
            });
        }
        Ok(out)
    })
}