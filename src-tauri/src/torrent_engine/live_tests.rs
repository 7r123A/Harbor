//! Real-swarm playback probe.
//!
//! Unlike the other unit tests this one needs the public network and a live
//! swarm, so it is ignored by default. It exists to validate the actual
//! playback data path (metadata -> file narrowing -> unpause -> head/tail
//! prefetch -> ranged reads) instead of only local fixtures.
//!
//! Run with:
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --lib live_swarm_playback_probe \
//!   -- --ignored --nocapture --test-threads=1
//! ```

use super::*;
use std::io::SeekFrom;

// Better.Call.Saul.S06E05.Black.and.Blue.ITA-ENG.2160p.WEBRip.AAC.x265-V3SP4EV3R
// (ilCorSaRoNeRo, 4K, ITA/ENG) from Torrentio. The torrent is a season pack, so
// the test locates the episode file by name and falls back to this index.
const BCS_S06E05_HASH: &str = "00fdabbcbcccb2b53d2e5034e369e1584a7735a4";
const BCS_S06E05_FILE_IDX: usize = 4;
const PROBE_HEAD_BYTES: u64 = 1024 * 1024;
const PROBE_TAIL_BYTES: u64 = 1024 * 1024;

fn probe_leg(leg: &Result<PrimeLeg, String>, label: &str) {
    match leg {
        Ok(leg) => eprintln!(
            "[live-probe] {label}: bytes={} ttfb_ms={} elapsed_ms={}",
            leg.bytes,
            leg.first_byte.as_millis(),
            leg.elapsed.as_millis()
        ),
        Err(error) => eprintln!("[live-probe] {label}: error={error}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs public network and a live swarm"]
async fn live_swarm_playback_probe() {
    // Same cranked DHT query budget the engine uses on desktop.
    std::env::set_var("DHT_QUERIES_PER_SECOND", "400");

    let dir = std::env::temp_dir().join(format!(
        "harbor-live-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    ));
    std::fs::create_dir_all(&dir).expect("probe dir");

    let tracker_urls: Vec<String> = trackers::ALL.iter().map(|t| t.to_string()).collect();
    let session = Session::new_with_opts(
        dir.clone(),
        SessionOptions {
            fastresume: false,
            disable_dht: false,
            trackers: trackers::as_url_set(),
            listen_port_range: Some(26941..26991),
            enable_upnp_port_forwarding: false,
            peer_opts: Some(PeerConnectionOptions {
                connect_timeout: Some(Duration::from_secs(3)),
                read_write_timeout: Some(Duration::from_secs(10)),
                keep_alive_interval: None,
            }),
            ..Default::default()
        },
    )
    .await
    .expect("session");

    let magnet = trackers::embed_into_magnet(
        &format!("magnet:?xt=urn:btih:{BCS_S06E05_HASH}"),
        &tracker_urls,
    );
    let options = AddTorrentOptions {
        overwrite: true,
        paused: true,
        skip_initial_check: true,
        only_files: Some(vec![BCS_S06E05_FILE_IDX]),
        trackers: Some(tracker_urls.clone()),
        peer_opts: Some(PeerConnectionOptions {
            connect_timeout: Some(Duration::from_secs(3)),
            read_write_timeout: Some(Duration::from_secs(10)),
            keep_alive_interval: None,
        }),
        force_tracker_interval: Some(Duration::from_secs(120)),
        ..Default::default()
    };

    let started = Instant::now();
    let added = timeout(
        Duration::from_secs(90),
        session.add_torrent(AddTorrent::from_url(magnet.as_str()), Some(options)),
    )
    .await
    .expect("metadata timed out")
    .expect("add torrent");
    let handle = added.into_handle().expect("list-only response");
    let metadata_ms = started.elapsed().as_millis();

    timeout(Duration::from_secs(60), handle.wait_until_initialized())
        .await
        .expect("init timed out")
        .expect("init");

    let files = handle
        .with_metadata(|meta| {
            meta.file_infos
                .iter()
                .map(|file| {
                    (
                        file.relative_filename.to_string_lossy().to_string(),
                        file.len,
                    )
                })
                .collect::<Vec<_>>()
        })
        .expect("metadata");
    let file_idx = files
        .iter()
        .position(|(name, _)| name.to_ascii_lowercase().contains("s06e05"))
        .unwrap_or(BCS_S06E05_FILE_IDX);
    let (name, len) = files
        .get(file_idx)
        .cloned()
        .expect("episode file present");
    eprintln!(
        "[live-probe] metadata_ms={metadata_ms} peers={} files={} file_idx={file_idx} file={name} len={len}",
        handle
            .stats()
            .live
            .as_ref()
            .map(|live| live.snapshot.peer_stats.live)
            .unwrap_or(0),
        files.len()
    );

    // Mirror torrent_engine_select: narrow, then unpause (discovery), then prime.
    timeout(
        Duration::from_secs(30),
        session.update_only_files(&handle, &HashSet::from([file_idx])),
    )
    .await
    .expect("narrow timed out")
    .expect("narrow");
    session.unpause(&handle).await.expect("unpause");

    let prime_started = Instant::now();
    let report = timeout(
        Duration::from_secs(120),
        prime_stream_head_tail(&handle, file_idx),
    )
    .await
    .expect("prime timed out");
    eprintln!(
        "[live-probe] prime total_ms={} peers={}",
        prime_started.elapsed().as_millis(),
        handle
            .stats()
            .live
            .as_ref()
            .map(|live| live.snapshot.peer_stats.live)
            .unwrap_or(0)
    );
    probe_leg(&report.head, "head(8MiB)");
    probe_leg(&report.tail, "tail(2MiB)");

    // Ranged reads through the same FileStream the HTTP server hands to mpv.
    let mut head_stream = handle.clone().stream(file_idx).expect("head stream");
    let mut buf = vec![0u8; PROBE_HEAD_BYTES as usize];
    let read_started = Instant::now();
    let mut read = 0usize;
    while read < buf.len() {
        let n = head_stream
            .read(&mut buf[read..])
            .await
            .expect("head read");
        if n == 0 {
            break;
        }
        read += n;
    }
    eprintln!(
        "[live-probe] served head read_bytes={read} elapsed_ms={} checksum_prefix={:02x?}",
        read_started.elapsed().as_millis(),
        &buf[..4.min(read)]
    );
    assert!(read > 0, "expected bytes from the head of the episode");

    let mut tail_stream = handle.clone().stream(file_idx).expect("tail stream");
    tail_stream
        .seek(SeekFrom::Start(len.saturating_sub(PROBE_TAIL_BYTES)))
        .await
        .expect("tail seek");
    let mut tail_buf = vec![0u8; PROBE_TAIL_BYTES as usize];
    let read_started = Instant::now();
    let mut read = 0usize;
    while read < tail_buf.len() {
        let n = tail_stream
            .read(&mut tail_buf[read..])
            .await
            .expect("tail read");
        if n == 0 {
            break;
        }
        read += n;
    }
    eprintln!(
        "[live-probe] served tail read_bytes={read} elapsed_ms={}",
        read_started.elapsed().as_millis()
    );
    assert!(read > 0, "expected bytes from the tail of the episode");

    match &report.head {
        Ok(leg) => assert!(leg.first_byte < Duration::from_secs(60), "head ttfb"),
        Err(error) => panic!("head prefetch failed: {error}"),
    }
    match &report.tail {
        Ok(leg) => assert!(leg.first_byte < Duration::from_secs(60), "tail ttfb"),
        Err(error) => panic!("tail prefetch failed: {error}"),
    }

    session.stop().await;
    let _ = std::fs::remove_dir_all(&dir);
}
