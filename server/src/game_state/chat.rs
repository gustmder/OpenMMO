use crate::types::{ClientKind, Player, PlayerId, ServerMessage};
use crate::world_config::world_config;
use tracing::{info, warn};

/// `/who` breakdown. Splits by client program rather than by "human vs bot":
/// the server cannot tell whether a person or an LLM is driving a web client,
/// and does not try to (`doc/REMOTE_AGENT_CLIENT.md`). Official NPCs are
/// counted separately because that one the server does know for certain.
#[derive(Default)]
struct OnlineCounts {
    web: u32,
    cli: u32,
    other: u32,
    official_npc: u32,
}

impl OnlineCounts {
    fn tally<'a>(players: impl Iterator<Item = &'a Player>) -> Self {
        let mut counts = Self::default();
        for player in players {
            if player.is_official_npc {
                counts.official_npc += 1;
                continue;
            }
            match player.client_kind {
                ClientKind::Web => counts.web += 1,
                ClientKind::Cli => counts.cli += 1,
                ClientKind::Other | ClientKind::Unknown => counts.other += 1,
            }
        }
        counts
    }

    fn describe(&self) -> String {
        let total = self.web + self.cli + self.other + self.official_npc;
        let mut parts = vec![format!("{} web", self.web), format!("{} cli", self.cli)];
        if self.other > 0 {
            parts.push(format!("{} other", self.other));
        }
        parts.push(format!("{} npc", self.official_npc));
        format!("Online: {total} ({})", parts.join(", "))
    }
}

impl super::GameState {
    pub async fn send_chat_message(&self, player_id: &PlayerId, message: String) {
        if message.trim() == "/escape" {
            self.escape_to_spawn(player_id).await;
            return;
        }

        if message.trim() == "/who" {
            let counts = {
                let players = self.players.read().await;
                OnlineCounts::tally(players.values())
            };
            self.send_direct_message(
                player_id,
                ServerMessage::ChatMessage {
                    player_id: *player_id,
                    message: counts.describe(),
                },
            )
            .await;
            return;
        }

        // Handle /give command
        if let Some(item_id) = message.strip_prefix("/give ") {
            let item_id = item_id.trim();
            if self.give_item(player_id, item_id).await {
                self.send_direct_message(
                    player_id,
                    ServerMessage::ChatMessage {
                        player_id: *player_id,
                        message: format!("Gave item: {}", item_id),
                    },
                )
                .await;
            } else {
                self.send_direct_message(
                    player_id,
                    ServerMessage::InventoryError {
                        message: format!("Unknown item: {}", item_id),
                    },
                )
                .await;
            }
            return;
        }

        let player_name = {
            let players = self.players.read().await;
            players.get(player_id).map(|player| player.name.clone())
        };

        if let Some(player_name) = player_name {
            // Chat content stays out of logs on purpose (privacy, F-012).
            info!(from = %player_name, len = message.len(), "chat message");
            let recipients = self
                .player_ids_within(player_id, super::EVENT_DELIVERY_RADIUS)
                .await;
            self.send_direct_message_to_players(
                &recipients,
                ServerMessage::ChatMessage {
                    player_id: *player_id,
                    message,
                },
            )
            .await;
        } else {
            warn!("Chat message from non-existent player: {}", player_id);
        }
    }

    /// Last resort for a player wedged somewhere movement can't undo: return
    /// them to the world spawn on the surface.
    ///
    /// Open to everyone by design — the players who need it are precisely the
    /// ones who cannot reach an admin. The combat lockout is what keeps it from
    /// doubling as a free disengage.
    async fn escape_to_spawn(&self, player_id: &PlayerId) {
        let reply = |message: &str| ServerMessage::ChatMessage {
            player_id: *player_id,
            message: message.to_string(),
        };

        let in_combat = {
            let players = self.players.read().await;
            let Some(player) = players.get(player_id) else {
                warn!("/escape from non-existent player: {}", player_id);
                return;
            };
            Self::now_ms().saturating_sub(player.last_combat_at) < super::OUT_OF_COMBAT_MS
        };
        if in_combat {
            self.send_direct_message(player_id, reply("Escape: not while in combat."))
                .await;
            return;
        }

        // Queued waypoints target the place being escaped from; snapping to one
        // after the teleport would drag the player straight back.
        self.movement_intents.write().await.remove(player_id);

        let spawn = &world_config().spawn_position;
        self.teleport_player(player_id, spawn.position(), spawn.rotation, 0)
            .await;
        info!("Player {} escaped to spawn", player_id);
        self.send_direct_message(player_id, reply("Escape: returned to the starting point."))
            .await;
    }
}
