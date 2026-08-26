use std::{
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{Mutex, mpsc},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tungstenite::{
    Error as WebSocketError, Message, accept_hdr_with_config,
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
    protocol::WebSocketConfig,
};

#[derive(Default)]
pub struct LiveHub {
    subscribers: Mutex<Vec<mpsc::Sender<String>>>,
}

impl LiveHub {
    pub fn broadcast(&self, frame: &Value) -> Result<usize, serde_json::Error> {
        let payload = serde_json::to_string(frame)?;
        let mut subscribers = self
            .subscribers
            .lock()
            .expect("live subscriber lock poisoned");
        subscribers.retain(|subscriber| subscriber.send(payload.clone()).is_ok());
        Ok(subscribers.len())
    }

    fn subscribe(&self) -> mpsc::Receiver<String> {
        let (sender, receiver) = mpsc::channel();
        self.subscribers
            .lock()
            .expect("live subscriber lock poisoned")
            .push(sender);
        receiver
    }

    #[cfg(test)]
    fn subscriber_count(&self) -> usize {
        self.subscribers.lock().unwrap().len()
    }
}

pub fn start_live_server(
    address: SocketAddr,
    token: String,
    allowed_origin: String,
    hub: std::sync::Arc<LiveHub>,
) -> std::io::Result<SocketAddr> {
    let listener = TcpListener::bind(address)?;
    let bound_address = listener.local_addr()?;
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            match connection {
                Ok(stream) => {
                    let Ok(peer) = stream.peer_addr() else {
                        continue;
                    };
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let token = token.clone();
                    let allowed_origin = allowed_origin.clone();
                    let hub = std::sync::Arc::clone(&hub);
                    std::thread::spawn(move || {
                        if let Err(error) =
                            handle_live_client(stream, &token, &allowed_origin, &hub)
                        {
                            eprintln!("otrace: live client disconnected: {error}");
                        }
                    });
                }
                Err(error) => eprintln!("otrace: live accept failed: {error}"),
            }
        }
    });
    Ok(bound_address)
}

#[allow(clippy::result_large_err)] // tungstenite's handshake callback fixes this response type.
fn handle_live_client(
    stream: TcpStream,
    token: &str,
    allowed_origin: &str,
    hub: &LiveHub,
) -> Result<(), Box<dyn std::error::Error>> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let origin = allowed_origin.to_owned();
    let callback = move |request: &Request, response: Response| {
        if request.uri().path() != "/v1/live" {
            return Err(rejection(StatusCode::NOT_FOUND, "unknown live endpoint"));
        }
        let request_origin = request
            .headers()
            .get("origin")
            .and_then(|value| value.to_str().ok());
        if !origin_is_allowed(request_origin, &origin) {
            return Err(rejection(StatusCode::FORBIDDEN, "origin is not allowed"));
        }
        Ok(response)
    };
    let config = WebSocketConfig::default()
        .read_buffer_size(8 * 1024)
        .write_buffer_size(8 * 1024)
        .max_write_buffer_size(64 * 1024)
        .max_message_size(Some(64 * 1024))
        .max_frame_size(Some(64 * 1024));
    let mut socket = accept_hdr_with_config(stream, callback, Some(config))?;
    let hello = socket.read()?;
    let hello: Value = serde_json::from_str(hello.to_text()?)?;
    if !hello_is_authorized(&hello, token) {
        socket.send(Message::text(
            json!({ "kind": "error", "message": "unauthorized" }).to_string(),
        ))?;
        socket.close(None)?;
        return Ok(());
    }
    socket.send(Message::text(
        json!({ "kind": "ready", "protocol": 1, "transport": "websocket" }).to_string(),
    ))?;
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(50)))?;
    let updates = hub.subscribe();
    let mut last_ping = Instant::now();
    loop {
        loop {
            match updates.try_recv() {
                Ok(payload) => socket.send(Message::text(payload))?,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
            }
        }
        match socket.read() {
            Ok(message) if message.is_close() => return Ok(()),
            Ok(_) => {}
            Err(WebSocketError::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed) => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        if last_ping.elapsed() >= Duration::from_secs(15) {
            socket.send(Message::Ping(Vec::new().into()))?;
            last_ping = Instant::now();
        }
    }
}

fn rejection(status: StatusCode, message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_owned()));
    *response.status_mut() = status;
    response
}

fn origin_is_allowed(origin: Option<&str>, allowed_origin: &str) -> bool {
    origin == Some(allowed_origin)
}

fn hello_is_authorized(hello: &Value, token: &str) -> bool {
    hello.get("kind").and_then(Value::as_str) == Some("hello")
        && hello.get("protocol").and_then(Value::as_u64) == Some(1)
        && hello.get("token").and_then(Value::as_str) == Some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_reaches_subscribers_and_prunes_disconnected_receivers() {
        let hub = LiveHub::default();
        let receiver = hub.subscribe();
        assert_eq!(
            hub.broadcast(&json!({ "kind": "catalog.updated" }))
                .unwrap(),
            1
        );
        assert_eq!(receiver.recv().unwrap(), r#"{"kind":"catalog.updated"}"#);
        drop(receiver);
        assert_eq!(hub.broadcast(&json!({ "kind": "next" })).unwrap(), 0);
        assert_eq!(hub.subscriber_count(), 0);
    }

    #[test]
    fn websocket_hello_requires_the_exact_protocol_and_token() {
        assert!(hello_is_authorized(
            &json!({ "kind": "hello", "protocol": 1, "token": "test-token" }),
            "test-token"
        ));
        assert!(!hello_is_authorized(
            &json!({ "kind": "hello", "protocol": 1, "token": "wrong" }),
            "test-token"
        ));
        assert!(!hello_is_authorized(
            &json!({ "kind": "hello", "protocol": 2, "token": "test-token" }),
            "test-token"
        ));
    }

    #[test]
    fn websocket_rejects_an_untrusted_origin() {
        assert!(origin_is_allowed(
            Some("http://127.0.0.1:4173"),
            "http://127.0.0.1:4173"
        ));
        assert!(!origin_is_allowed(
            Some("http://attacker.invalid"),
            "http://127.0.0.1:4173"
        ));
        assert!(!origin_is_allowed(None, "http://127.0.0.1:4173"));
    }
}
