#![cfg(unix)]

mod common;

use base64::Engine;
use common::Node;
use serde_json::json;

#[tokio::test]
async fn signs_only_bounded_node_endpoint_challenges_as_exact_utf8() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = Node::start(dir.path(), "signer").await;
    let message = "erainfra/node-endpoint/v1\n{\"nodeId\":\"节点\",\"nonce\":\"one-use\"}";
    let result = a
        .ok(json!({"v":1,"op":"sign_challenge","message":message}))
        .await;
    assert_eq!(result["endpoint_id"], a.id());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(result["signature"].as_str().unwrap())
        .unwrap();
    let signature = iroh::Signature::from_bytes(&bytes.try_into().unwrap());
    let public = erainfra_mesh::key::load(&a.key).unwrap().public();
    public.verify(message.as_bytes(), &signature).unwrap();
    assert!(
        public
            .verify(message.replace("one-use", "other").as_bytes(), &signature)
            .is_err()
    );
    for bad in [
        "arbitrary message".to_string(),
        format!("erainfra/node-endpoint/v1\n{}", "x".repeat(4096)),
    ] {
        let reply = a
            .call(json!({"v":1,"op":"sign_challenge","message":bad}))
            .await;
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["code"], "bad_request");
    }
    a.stop().await;
}
