use super::*;
use std::{collections::HashSet,net::SocketAddr,sync::{Arc,Mutex,atomic::{AtomicUsize,Ordering}},time::Instant};
use axum::{extract::{ConnectInfo,OriginalUri,State},routing::get,Json,Router};
use serde_json::json;
#[derive(Clone,Default)]
struct ProbeFixture { peers:Arc<Mutex<HashSet<SocketAddr>>>, active:Arc<AtomicUsize>, peak:Arc<AtomicUsize>, origin:String }
async fn fixture_doc(State(s):State<ProbeFixture>,ConnectInfo(peer):ConnectInfo<SocketAddr>,OriginalUri(uri):OriginalUri,headers:axum::http::HeaderMap)->Json<Value>{
    assert!(!headers.contains_key("authorization")&&!headers.contains_key("cookie"));
    s.peers.lock().unwrap().insert(peer);
    let active=s.active.fetch_add(1,Ordering::SeqCst)+1;s.peak.fetch_max(active,Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(40)).await;
    let value=match uri.path(){
      "/mcp"=>json!({"name":"coding-tools-mcp","version":"fixture","protocolVersion":"2025-11-25"}),
      "/.well-known/oauth-authorization-server"=>json!({"issuer":s.origin,"authorization_endpoint":format!("{}/oauth/authorize",s.origin),"token_endpoint":format!("{}/oauth/token",s.origin),"grant_types_supported":["refresh_token"],"code_challenge_methods_supported":["S256"]}),
      "/.well-known/oauth-protected-resource"=>json!({"resource":s.origin,"authorization_servers":[s.origin]}),
      _=>json!({"ok":true,"service":"coding-tools-actions","tools_loaded":71})
    };
    s.active.fetch_sub(1,Ordering::SeqCst);Json(value)
}
#[tokio::test]
async fn quick_connection_pool_parallelism_and_credential_boundaries(){
    let socket=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin=format!("http://{}",socket.local_addr().unwrap());
    let fixture=ProbeFixture{origin:origin.clone(),..Default::default()};
    let (end,rx)=tokio::sync::oneshot::channel();
    let app=Router::new().route("/mcp",get(fixture_doc)).route("/health",get(fixture_doc))
      .route("/.well-known/oauth-authorization-server",get(fixture_doc))
      .route("/.well-known/oauth-protected-resource",get(fixture_doc)).with_state(fixture.clone());
    let server=tokio::spawn(async move{axum::serve(socket,app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(async{let _=rx.await;}).await.unwrap();});
    let mut settings=AppSettings::default();settings.proxy.mode="none".into();
    for _ in 0..4 { document(&client(&settings).unwrap(),&format!("{origin}/mcp")).await.unwrap(); }
    let pooled_connections=fixture.peers.lock().unwrap().len();
    fixture.peak.store(0,Ordering::SeqCst);
    let c=client(&settings).unwrap();
    probe_with_client(&origin,TunnelServiceKind::Mcp,true,&c).await.unwrap();
    let parallel_requests=fixture.peak.load(Ordering::SeqCst);
    let mut serial_ms=vec![];let mut parallel_ms=vec![];
    for _ in 0..5 {
        let started=Instant::now();
        for path in ["/mcp","/.well-known/oauth-authorization-server","/.well-known/oauth-protected-resource"] {
            document(&c,&format!("{origin}{path}")).await.unwrap();
        }
        serial_ms.push(started.elapsed().as_micros() as f64/1000.0);
        let started=Instant::now();probe_with_client(&origin,TunnelServiceKind::Mcp,true,&c).await.unwrap();
        parallel_ms.push(started.elapsed().as_micros() as f64/1000.0);
    }
    probe_with_client(&origin,TunnelServiceKind::Actions,true,&c).await.unwrap();
    let mut invalid=settings.clone();invalid.proxy.mode="manual".into();invalid.proxy.url="http://[".into();
    assert!(client(&invalid).is_err(),"Invalid changed proxy must not reuse a prior direct client");
    assert!(validate_authorization("https://different.example",&document(&c,&format!("{origin}/.well-known/oauth-authorization-server")).await.unwrap()).is_err());
    let _=end.send(());server.await.unwrap();
    println!("QUICK_PROBE_EVIDENCE {}",json!({"pooled_connections":pooled_connections,"parallel_requests":parallel_requests,"serial_ms":serial_ms,"parallel_ms":parallel_ms,"fixture_delay_ms":40,"sample_count":5,"public_network_measured":false,"no_credentials_sent":true}));
    assert_eq!(pooled_connections,1,"PROBE_REBUILDS_CLIENT_EVERY_CALL");
    assert!(parallel_requests>=2,"OAUTH_PROBES_ARE_SERIAL");
}
