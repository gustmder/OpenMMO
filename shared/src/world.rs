//! World primitives: 3D position, axis-aligned no-spawn rectangles, and
//! the in-game calendar/clock value the server broadcasts. Tiny but
//! shared by virtually every other type, so they live in one place that
//! has no dependencies on the rest of the crate.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Position {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Position {
    /// Squared distance in the X-Z (ground) plane, ignoring height. Squared
    /// to avoid a `sqrt` when callers only compare against a radius.
    pub fn dist_xz_sq(&self, other: &Position) -> f32 {
        let dx = self.x - other.x;
        let dz = self.z - other.z;
        dx * dx + dz * dz
    }
}

/// Distance (game units) within which agent (NPC) clients perceive nearby
/// humans and monsters. The server uses it to decide which gameplay events to
/// deliver to an agent connection; the agent-client uses the same value to
/// decide which entities to surface to the LLM. Shared so the two stay equal.
pub const NPC_SIGHT_RADIUS: f32 = 27.0;

/// Axis-aligned rectangular zone where monsters must not spawn (e.g. towns).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoSpawnZone {
    pub min_x: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_z: f32,
}

impl NoSpawnZone {
    pub fn contains(&self, x: f32, z: f32) -> bool {
        x >= self.min_x && x <= self.max_x && z >= self.min_z && z <= self.max_z
    }

    /// Like `contains`, but with the rectangle expanded by `margin` on all
    /// sides — used to keep spawns clear of the area *around* a town too.
    pub fn contains_with_margin(&self, x: f32, z: f32, margin: f32) -> bool {
        x >= self.min_x - margin
            && x <= self.max_x + margin
            && z >= self.min_z - margin
            && z <= self.max_z + margin
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameDateTime {
    pub year: u32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
}
