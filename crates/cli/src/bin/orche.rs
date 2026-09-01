use std::{
    collections::BTreeMap,
    env, fs, io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use chrono::{DateTime, Local};
use crossterm::{
    cursor::{Hide, Show},
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
        KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    },
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use orchetrace_core::{
    AgentSnapshot, RunSnapshot, TimelineEntry, TokenUsageSnapshot, ToolSnapshot,
};
use orchetrace_ingest::{RunCatalog, RunSummary};
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    buffer::Buffer,
    layout::{Constraint, Direction, Layout, Position, Rect},
    prelude::Stylize,
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

#[path = "orche_managed.rs"]
mod managed;

use managed::ManagedObservers;

const ACCENT: Color = Color::Rgb(228, 185, 0);
const GREEN: Color = Color::Rgb(112, 217, 130);
const RED: Color = Color::Rgb(255, 98, 104);
const MUTED: Color = Color::Rgb(105, 106, 100);
const TEXT: Color = Color::Rgb(235, 233, 223);
const PANEL: Color = Color::Rgb(25, 26, 23);
const CANVAS: Color = Color::Rgb(14, 15, 14);
const GRID: Color = Color::Rgb(37, 39, 35);
const BORDER: Color = Color::Rgb(61, 63, 58);
const TRACK: Color = Color::Rgb(47, 49, 44);
const FUTURE: Color = Color::Rgb(82, 83, 77);
const PLAYBACK_SPEEDS: &[f64] = &[0.25, 0.5, 1.0, 2.0, 4.0, 8.0];

fn main() {
    if let Err(error) = run() {
        eprintln!("orche: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse(env::args().skip(1))?;
    if args.help {
        print_help();
        return Ok(());
    }
    if let Some(hooks) = args.hooks {
        managed::run_runtime_hooks(&hooks.runtime, &hooks.action)?;
        return Ok(());
    }
    let data_dir = args.data_dir.unwrap_or_else(discover_data_dir);
    let observers = if args.replay_only {
        ManagedObservers::disabled()
    } else {
        ManagedObservers::start(&data_dir)
    };
    let mut app = App::load(
        data_dir,
        args.run_id,
        args.refresh,
        observers.summary.clone(),
    )?;

    enable_raw_mode()?;
    execute!(io::stdout(), EnterAlternateScreen, EnableMouseCapture, Hide)?;
    let _session = TerminalSession;
    let observers = observers;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    terminal.clear()?;

    while !app.quit {
        terminal.draw(|frame| draw(frame, &app))?;
        let wait = Duration::from_millis(45);
        if event::poll(wait)? {
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    if let Some(action) = app.on_key(key)? {
                        app.apply_session_action(action, &observers);
                    }
                }
                Event::Mouse(mouse) => {
                    let size = terminal.size()?;
                    app.on_mouse(mouse, Rect::new(0, 0, size.width, size.height))?;
                }
                _ => {}
            }
        }
        app.tick()?;
    }
    Ok(())
}

struct TerminalSession;

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            io::stdout(),
            DisableMouseCapture,
            Show,
            LeaveAlternateScreen
        );
    }
}

#[derive(Default)]
struct Args {
    data_dir: Option<PathBuf>,
    run_id: Option<String>,
    refresh: Duration,
    replay_only: bool,
    help: bool,
    hooks: Option<HookCommand>,
}

struct HookCommand {
    runtime: String,
    action: String,
}

impl Args {
    fn parse(values: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut args = values.into_iter();
        let mut parsed = Self {
            refresh: Duration::from_millis(500),
            ..Self::default()
        };
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--data-dir" => {
                    parsed.data_dir =
                        Some(PathBuf::from(args.next().ok_or("missing --data-dir path")?));
                }
                "--run" => parsed.run_id = Some(args.next().ok_or("missing --run id")?),
                "--refresh-ms" => {
                    let value = args
                        .next()
                        .ok_or("missing --refresh-ms value")?
                        .parse::<u64>()
                        .map_err(|_| "--refresh-ms must be an integer")?;
                    parsed.refresh = Duration::from_millis(value.clamp(100, 10_000));
                }
                "--replay" | "--no-observe" => parsed.replay_only = true,
                "hooks" => {
                    if parsed.hooks.is_some() {
                        return Err("hooks command may only be provided once".into());
                    }
                    parsed.hooks = Some(HookCommand {
                        runtime: args.next().ok_or("missing hooks runtime")?,
                        action: args.next().ok_or("missing hooks action")?,
                    });
                }
                "--help" | "-h" => parsed.help = true,
                _ => return Err(format!("unknown argument `{arg}`")),
            }
        }
        Ok(parsed)
    }
}

fn print_help() {
    println!(
        "orche — terminal multi-Agent observer\n\n\
         Usage: orche [--data-dir PATH] [--run RUN_ID] [--refresh-ms 500] [--replay]\n\
                orche hooks <runtime> <install|status|uninstall>\n\n\
         By default, orche starts the local ingest service and passively observes\n\
         current Claude, Codex, Pi, DeepSeek Harness, and Antigravity sessions.\n\
         --replay disables observation. Runtime aliases such as claude and agy are accepted.\n\n\
         Keys:\n\
           q              quit\n\
           ↑/↓ or j/k     select Agent / adjacent session\n\
           Tab/Shift+Tab  next/previous session\n\
           Enter/click    open/close Agent detail\n\
           ←/→ or h/l     scrub real timeline\n\
           Home/End       first/latest state\n\
           Space          play/pause at selected speed\n\
           , / .          slower/faster playback\n\
           [ / ]          previous/next session\n\
           f              follow newest live session\n\
           r              reload snapshot\n\
           e              rename current session\n\
           d              delete current session\n\
           ?              help overlay"
    );
}

enum SessionDialog {
    Rename { value: String },
    DeleteConfirm,
}

#[derive(Debug, PartialEq)]
enum SessionAction {
    Rename(String),
    Delete,
}

type TokenUsageIndex = BTreeMap<String, Vec<(i64, TokenUsageSnapshot)>>;

struct SnapshotLoad {
    snapshot: RunSnapshot,
    timeline_complete: bool,
}

fn empty_snapshot_load() -> SnapshotLoad {
    SnapshotLoad {
        snapshot: RunSnapshot {
            schema_version: orchetrace_protocol::SCHEMA_VERSION,
            root_session_id: String::new(),
            runtimes: Vec::new(),
            event_count: 0,
            started_at: None,
            last_activity_at: None,
            agents: Vec::new(),
            edges: Vec::new(),
            timeline: Vec::new(),
        },
        timeline_complete: true,
    }
}

struct App {
    data_dir: PathBuf,
    catalog: RunCatalog,
    run_index: usize,
    snapshot: RunSnapshot,
    timeline_complete: bool,
    token_index: TokenUsageIndex,
    selected_id: String,
    cursor_ms: i64,
    playing: bool,
    playback_speed_index: usize,
    follow_latest: bool,
    detail_open: bool,
    detail_scroll: u16,
    help_open: bool,
    session_dialog: Option<SessionDialog>,
    quit: bool,
    refresh: Duration,
    last_refresh: Instant,
    last_tick: Instant,
    notice: String,
    observer_status: String,
    auto_run: bool,
}

impl App {
    fn has_runs(&self) -> bool {
        !self.catalog.runs.is_empty()
    }

    fn enter_empty_state(&mut self, catalog: RunCatalog, notice: impl Into<String>) {
        self.catalog = catalog;
        self.run_index = 0;
        self.install_snapshot(empty_snapshot_load());
        self.selected_id.clear();
        self.cursor_ms = 0;
        self.playing = false;
        self.follow_latest = true;
        self.detail_open = false;
        self.detail_scroll = 0;
        self.session_dialog = None;
        self.auto_run = true;
        self.notice = notice.into();
    }

    fn install_snapshot(&mut self, loaded: SnapshotLoad) {
        self.snapshot = loaded.snapshot;
        self.timeline_complete = loaded.timeline_complete;
        self.token_index = build_token_index(&self.snapshot.timeline);
    }

    fn ensure_full_timeline(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if self.timeline_complete || !self.has_runs() {
            return Ok(());
        }
        let run_id = self.summary().run_id.clone();
        let total = load_full_timeline(&self.data_dir, &run_id, &mut self.snapshot)?;
        self.timeline_complete = true;
        self.token_index = build_token_index(&self.snapshot.timeline);
        self.notice = format!("FULL TIMELINE · {total} EVENTS");
        Ok(())
    }

    fn load(
        data_dir: PathBuf,
        requested_run: Option<String>,
        refresh: Duration,
        observer_status: String,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let catalog = read_catalog(&data_dir)?;
        let has_runs = !catalog.runs.is_empty();
        let auto_run = requested_run.is_none();
        let run_index = if !has_runs {
            0
        } else {
            requested_run
                .as_deref()
                .and_then(|id| catalog.runs.iter().position(|run| run.run_id == id))
                .or_else(|| most_recent_run_index(&catalog))
                .unwrap_or(0)
        };
        let loaded = if !has_runs {
            empty_snapshot_load()
        } else {
            read_snapshot_state(&data_dir, &catalog.runs[run_index].run_id)?
        };
        let snapshot = loaded.snapshot;
        let token_index = build_token_index(&snapshot.timeline);
        let (_, end) = snapshot_bounds(&snapshot);
        let selected_id = snapshot.root_session_id.clone();
        Ok(Self {
            data_dir,
            catalog,
            run_index,
            snapshot,
            timeline_complete: loaded.timeline_complete,
            token_index,
            selected_id,
            cursor_ms: end,
            playing: false,
            playback_speed_index: 2,
            follow_latest: true,
            detail_open: false,
            detail_scroll: 0,
            help_open: false,
            session_dialog: None,
            quit: false,
            refresh,
            last_refresh: Instant::now(),
            last_tick: Instant::now(),
            notice: if !has_runs {
                "WAITING FOR SESSION".into()
            } else {
                "LIVE FOLLOW".into()
            },
            observer_status,
            auto_run,
        })
    }

    fn summary(&self) -> &RunSummary {
        &self.catalog.runs[self.run_index]
    }

    fn visible_agents(&self) -> Vec<AgentSnapshot> {
        snapshot_at(&self.snapshot, self.cursor_ms, &self.token_index)
    }

    fn on_key(
        &mut self,
        key: KeyEvent,
    ) -> Result<Option<SessionAction>, Box<dyn std::error::Error>> {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.quit = true;
            return Ok(None);
        }
        if self.session_dialog.is_some() {
            return Ok(self.on_session_dialog_key(key));
        }
        if self.help_open {
            self.help_open = false;
            return Ok(None);
        }
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Esc if self.detail_open => {
                self.detail_open = false;
                self.detail_scroll = 0;
            }
            KeyCode::Esc => self.quit = true,
            KeyCode::Char('?') => self.help_open = true,
            KeyCode::Enter => {
                self.ensure_full_timeline()?;
                self.detail_open = !self.detail_open;
                self.detail_scroll = 0;
            }
            KeyCode::Up | KeyCode::Char('k') => self.select_delta(-1)?,
            KeyCode::Down | KeyCode::Char('j') => self.select_delta(1)?,
            KeyCode::BackTab => self.change_run(-1)?,
            KeyCode::Tab => self.change_run(1)?,
            KeyCode::Left | KeyCode::Char('h') => {
                self.ensure_full_timeline()?;
                self.scrub(-1);
            }
            KeyCode::Right | KeyCode::Char('l') => self.scrub(1),
            KeyCode::Home => {
                self.ensure_full_timeline()?;
                self.jump(false);
            }
            KeyCode::End => self.jump(true),
            KeyCode::Char(' ') => {
                self.ensure_full_timeline()?;
                self.toggle_play();
            }
            KeyCode::Char(',' | '<') => self.change_playback_speed(-1),
            KeyCode::Char('.' | '>') => self.change_playback_speed(1),
            KeyCode::Char('f') => {
                if self.auto_run && self.follow_latest {
                    self.auto_run = false;
                    self.notice = "SESSION PINNED".into();
                } else {
                    self.follow_newest_run()?;
                }
            }
            KeyCode::Char('r') => self.reload(true)?,
            KeyCode::Char('e') => {
                if !self.has_runs() {
                    self.notice = "WAITING FOR SESSION".into();
                    return Ok(None);
                }
                self.detail_open = false;
                self.session_dialog = Some(SessionDialog::Rename {
                    value: self.summary().label.clone(),
                });
            }
            KeyCode::Char('d') => {
                if !self.has_runs() {
                    self.notice = "WAITING FOR SESSION".into();
                    return Ok(None);
                }
                self.detail_open = false;
                self.session_dialog = Some(SessionDialog::DeleteConfirm);
            }
            KeyCode::Char('[') => self.change_run(-1)?,
            KeyCode::Char(']') => self.change_run(1)?,
            _ => {}
        }
        Ok(None)
    }

    fn on_session_dialog_key(&mut self, key: KeyEvent) -> Option<SessionAction> {
        if key.code == KeyCode::Esc {
            self.session_dialog = None;
            self.notice = "SESSION ACTION CANCELLED".into();
            return None;
        }
        match self.session_dialog.as_mut()? {
            SessionDialog::Rename { value } => match key.code {
                KeyCode::Enter => {
                    let label = value.trim().to_owned();
                    if label.is_empty() {
                        self.notice = "SESSION NAME CANNOT BE EMPTY".into();
                        return None;
                    }
                    if label.chars().count() > 80 {
                        self.notice = "SESSION NAME IS LIMITED TO 80 CHARACTERS".into();
                        return None;
                    }
                    self.session_dialog = None;
                    Some(SessionAction::Rename(label))
                }
                KeyCode::Backspace => {
                    value.pop();
                    None
                }
                KeyCode::Char(character)
                    if !key.modifiers.contains(KeyModifiers::CONTROL)
                        && !character.is_control()
                        && value.chars().count() < 80 =>
                {
                    value.push(character);
                    None
                }
                _ => None,
            },
            SessionDialog::DeleteConfirm => match key.code {
                KeyCode::Char('y' | 'Y') | KeyCode::Enter => {
                    self.session_dialog = None;
                    Some(SessionAction::Delete)
                }
                KeyCode::Char('n' | 'N') => {
                    self.session_dialog = None;
                    self.notice = "SESSION DELETE CANCELLED".into();
                    None
                }
                _ => None,
            },
        }
    }

    fn apply_session_action(&mut self, action: SessionAction, observers: &ManagedObservers) {
        if !self.has_runs() {
            self.notice = "WAITING FOR SESSION".into();
            return;
        }
        let run = self.summary().clone();
        match action {
            SessionAction::Rename(label) => match observers.rename_session(&run, &label) {
                Ok(()) => match self.reload(true) {
                    Ok(()) => self.notice = format!("RENAMED · {label}"),
                    Err(error) => self.notice = format!("RELOAD ERROR · {error}"),
                },
                Err(error) => self.notice = format!("RENAME ERROR · {error}"),
            },
            SessionAction::Delete => match observers.delete_session(&run) {
                Ok((deleted_sessions, deleted_events)) => match read_catalog(&self.data_dir) {
                    Ok(catalog) if catalog.runs.is_empty() => {
                        self.enter_empty_state(
                            catalog,
                            format!(
                                "DELETED {deleted_sessions} SESSIONS · {deleted_events} EVENTS · WAITING"
                            ),
                        );
                    }
                    Ok(catalog) => {
                        self.run_index = self.run_index.min(catalog.runs.len() - 1);
                        self.catalog = catalog;
                        match read_snapshot_state(&self.data_dir, &self.summary().run_id) {
                            Ok(loaded) => {
                                self.install_snapshot(loaded);
                                self.cursor_ms = snapshot_bounds(&self.snapshot).1;
                                self.selected_id.clone_from(&self.snapshot.root_session_id);
                                self.playing = false;
                                self.follow_latest = true;
                                self.detail_open = false;
                                self.detail_scroll = 0;
                                self.auto_run = false;
                                self.notice = format!(
                                    "DELETED {deleted_sessions} SESSIONS · {deleted_events} EVENTS"
                                );
                            }
                            Err(error) => self.notice = format!("RELOAD ERROR · {error}"),
                        }
                    }
                    Err(error) => self.notice = format!("RELOAD ERROR · {error}"),
                },
                Err(error) => self.notice = format!("DELETE ERROR · {error}"),
            },
        }
    }

    fn on_mouse(
        &mut self,
        mouse: MouseEvent,
        area: Rect,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if self.session_dialog.is_some() {
            return Ok(());
        }
        let Some((_, graph, timeline, _)) = screen_regions(area, self.snapshot.agents.len()) else {
            return Ok(());
        };
        if self.detail_open && contains(detail_area(graph), mouse.column, mouse.row) {
            match mouse.kind {
                MouseEventKind::ScrollUp => {
                    self.detail_scroll = self.detail_scroll.saturating_sub(2);
                    return Ok(());
                }
                MouseEventKind::ScrollDown => {
                    self.detail_scroll = self
                        .detail_scroll
                        .saturating_add(2)
                        .min(detail_scroll_limit(graph, self));
                    return Ok(());
                }
                MouseEventKind::Down(_) => return Ok(()),
                _ => {}
            }
        }
        match mouse.kind {
            MouseEventKind::ScrollUp => {
                self.select_agent_delta(-1);
                return Ok(());
            }
            MouseEventKind::ScrollDown => {
                self.select_agent_delta(1);
                return Ok(());
            }
            MouseEventKind::Down(MouseButton::Left) => {}
            _ => return Ok(()),
        }
        if self.help_open {
            self.help_open = false;
            return Ok(());
        }
        let agents = self.visible_agents();
        let inner = graph.inner(ratatui::layout::Margin {
            horizontal: 1,
            vertical: 1,
        });
        let positions = graph_positions(&agents, inner);
        if let Some(agent_id) = agents
            .iter()
            .find(|agent| {
                positions
                    .get(&agent.id)
                    .is_some_and(|rect| contains(*rect, mouse.column, mouse.row))
            })
            .map(|agent| agent.id.clone())
        {
            self.ensure_full_timeline()?;
            self.selected_id = agent_id;
            self.detail_open = true;
            self.detail_scroll = 0;
            self.auto_run = false;
            return Ok(());
        }
        if contains(timeline, mouse.column, mouse.row) {
            self.ensure_full_timeline()?;
            self.seek_timeline(mouse.column, mouse.row, timeline);
            return Ok(());
        }
        if self.detail_open && contains(graph, mouse.column, mouse.row) {
            self.detail_open = false;
            self.detail_scroll = 0;
        }
        Ok(())
    }

    fn tick(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if self.quit {
            return Ok(());
        }
        let now = Instant::now();
        if self.playing {
            let elapsed = now.duration_since(self.last_tick).as_millis() as i64;
            let (_, end) = snapshot_bounds(&self.snapshot);
            let scaled = scale_playback_elapsed(elapsed, self.playback_speed());
            self.cursor_ms = (self.cursor_ms + scaled).min(end);
            if self.cursor_ms >= end {
                self.playing = false;
                self.follow_latest = true;
                self.notice = "LATEST STATE".into();
            }
            self.ensure_selection_visible();
        }
        self.last_tick = now;
        if now.duration_since(self.last_refresh) >= self.refresh {
            self.reload(false)?;
            self.last_refresh = now;
        }
        Ok(())
    }

    fn reload(&mut self, manual: bool) -> Result<(), Box<dyn std::error::Error>> {
        let catalog = read_catalog(&self.data_dir)?;
        if catalog.runs.is_empty() {
            if self.has_runs() {
                self.enter_empty_state(catalog, "NO SESSIONS · WAITING");
            } else {
                self.catalog = catalog;
                if manual {
                    self.notice = "NO SESSIONS · WAITING".into();
                }
            }
            return Ok(());
        }
        if !self.has_runs() {
            self.run_index = most_recent_run_index(&catalog).unwrap_or(0);
            self.catalog = catalog;
            let loaded = read_snapshot_state(&self.data_dir, &self.summary().run_id)?;
            self.install_snapshot(loaded);
            self.cursor_ms = snapshot_bounds(&self.snapshot).1;
            self.selected_id.clone_from(&self.snapshot.root_session_id);
            self.follow_latest = true;
            self.auto_run = true;
            self.notice = format!("LIVE {}", runtime_label(self.summary()));
            return Ok(());
        }
        let current_id = self.summary().run_id.clone();
        let next_index = preferred_reload_run_index(
            &self.catalog,
            &current_id,
            &catalog,
            self.auto_run,
            self.follow_latest,
        )
        .unwrap_or(0);
        let run_changed = catalog.runs[next_index].run_id != current_id;
        self.run_index = next_index;
        let summary = &catalog.runs[self.run_index];
        let changed = run_changed
            || summary.event_count != self.snapshot.event_count
            || summary.last_activity_at != self.snapshot.last_activity_at;
        self.catalog = catalog;
        if changed || manual {
            let preserve_full = !run_changed && self.timeline_complete;
            let loaded = read_snapshot_state(&self.data_dir, &self.summary().run_id)?;
            self.install_snapshot(loaded);
            if preserve_full {
                self.ensure_full_timeline()?;
            }
            if run_changed {
                self.selected_id.clone_from(&self.snapshot.root_session_id);
                self.detail_open = false;
                self.detail_scroll = 0;
                self.notice = format!("LIVE {}", runtime_label(self.summary()));
            }
            if self.follow_latest {
                self.cursor_ms = snapshot_bounds(&self.snapshot).1;
            }
            self.ensure_selection_visible();
            if manual {
                self.notice = "SNAPSHOT RELOADED".into();
            }
        }
        Ok(())
    }

    fn change_run(&mut self, delta: isize) -> Result<(), Box<dyn std::error::Error>> {
        if !self.has_runs() {
            self.notice = "WAITING FOR SESSION".into();
            return Ok(());
        }
        let count = self.catalog.runs.len() as isize;
        self.run_index = (self.run_index as isize + delta).rem_euclid(count) as usize;
        let loaded = read_snapshot_state(&self.data_dir, &self.summary().run_id)?;
        self.install_snapshot(loaded);
        self.cursor_ms = snapshot_bounds(&self.snapshot).1;
        self.selected_id.clone_from(&self.snapshot.root_session_id);
        self.playing = false;
        self.follow_latest = true;
        self.detail_open = false;
        self.detail_scroll = 0;
        self.auto_run = false;
        self.notice = format!("SESSION {}/{}", self.run_index + 1, self.catalog.runs.len());
        Ok(())
    }

    fn select_delta(&mut self, delta: isize) -> Result<(), Box<dyn std::error::Error>> {
        let agents = self.visible_agents();
        if agents.is_empty() {
            return Ok(());
        }
        let current = agents
            .iter()
            .position(|agent| agent.id == self.selected_id)
            .unwrap_or(0) as isize;
        let next = current + delta;
        if (0..agents.len() as isize).contains(&next) {
            self.selected_id.clone_from(&agents[next as usize].id);
            self.detail_scroll = 0;
            self.auto_run = false;
            self.notice = "SESSION PINNED".into();
            return Ok(());
        }

        self.change_run(delta.signum())?;
        if delta < 0
            && let Some(agent) = self.visible_agents().last()
        {
            self.selected_id.clone_from(&agent.id);
        }
        Ok(())
    }

    fn select_agent_delta(&mut self, delta: isize) {
        let agents = self.visible_agents();
        let Some(current) = agents
            .iter()
            .position(|agent| agent.id == self.selected_id)
            .map(|index| index as isize)
        else {
            return;
        };
        let next = current + delta;
        if (0..agents.len() as isize).contains(&next) {
            self.selected_id.clone_from(&agents[next as usize].id);
            self.detail_scroll = 0;
            self.auto_run = false;
            self.notice = "SESSION PINNED".into();
        }
    }

    fn scrub(&mut self, direction: i64) {
        let (start, end) = snapshot_bounds(&self.snapshot);
        let step = ((end - start) / 50).max(100);
        self.cursor_ms = (self.cursor_ms + direction * step).clamp(start, end);
        self.playing = false;
        self.follow_latest = self.cursor_ms == end;
        self.auto_run = false;
        self.notice = if self.follow_latest {
            "LATEST STATE".into()
        } else {
            "HISTORY PINNED".into()
        };
        self.ensure_selection_visible();
    }

    fn jump(&mut self, end: bool) {
        let bounds = snapshot_bounds(&self.snapshot);
        self.cursor_ms = if end { bounds.1 } else { bounds.0 };
        self.playing = false;
        self.follow_latest = end;
        self.auto_run = false;
        self.ensure_selection_visible();
    }

    fn toggle_play(&mut self) {
        if !self.has_runs() {
            self.notice = "WAITING FOR SESSION".into();
            return;
        }
        let (start, end) = snapshot_bounds(&self.snapshot);
        if self.playing {
            self.playing = false;
            self.notice = "PAUSED".into();
            return;
        }
        if self.cursor_ms >= end {
            self.cursor_ms = start;
        }
        self.playing = true;
        self.follow_latest = false;
        self.auto_run = false;
        self.last_tick = Instant::now();
        self.notice = format!("PLAY {}", self.playback_speed_label());
        self.ensure_selection_visible();
    }

    fn playback_speed(&self) -> f64 {
        PLAYBACK_SPEEDS[self.playback_speed_index]
    }

    fn playback_speed_label(&self) -> String {
        format!("{}×", self.playback_speed())
    }

    fn change_playback_speed(&mut self, delta: isize) {
        self.playback_speed_index = (self.playback_speed_index as isize + delta)
            .clamp(0, PLAYBACK_SPEEDS.len() as isize - 1)
            as usize;
        self.last_tick = Instant::now();
        self.notice = format!("SPEED {}", self.playback_speed_label());
    }

    fn ensure_selection_visible(&mut self) {
        let agents = self.visible_agents();
        if !agents.iter().any(|agent| agent.id == self.selected_id)
            && let Some(agent) = agents.first()
        {
            self.selected_id.clone_from(&agent.id);
            self.detail_open = false;
            self.detail_scroll = 0;
        }
    }

    fn seek_timeline(&mut self, column: u16, row: u16, area: Rect) {
        let block = Block::default().borders(Borders::ALL);
        let inner = block.inner(area);
        if inner.width == 0 || inner.height == 0 {
            return;
        }
        let label_width = 14_u16.min(inner.width / 3);
        let track_x = inner.x + label_width;
        let track_width = inner.width.saturating_sub(label_width + 1).max(1);
        if column >= track_x && column < track_x + track_width {
            let (start, end) = snapshot_bounds(&self.snapshot);
            let offset = column.saturating_sub(track_x) as i64;
            self.cursor_ms =
                start + offset * (end - start) / track_width.saturating_sub(1).max(1) as i64;
            self.playing = false;
            self.follow_latest = self.cursor_ms >= end;
            self.auto_run = false;
            self.notice = if self.follow_latest {
                "LATEST STATE".into()
            } else {
                "HISTORY PINNED".into()
            };
            self.ensure_selection_visible();
        }
        let lane_y = inner.y.saturating_add(2);
        let max_lanes = inner.height.saturating_sub(3) as usize;
        if row >= lane_y && row < lane_y.saturating_add(max_lanes as u16) {
            let selected_index = self
                .snapshot
                .agents
                .iter()
                .position(|agent| agent.id == self.selected_id)
                .unwrap_or(0);
            let offset = selected_index
                .saturating_sub(max_lanes.saturating_sub(1))
                .min(self.snapshot.agents.len().saturating_sub(max_lanes));
            if let Some(agent) = self
                .snapshot
                .agents
                .get(offset + row.saturating_sub(lane_y) as usize)
            {
                self.selected_id.clone_from(&agent.id);
                self.auto_run = false;
            }
        }
    }

    fn follow_newest_run(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if !self.has_runs() {
            self.notice = "WAITING FOR SESSION".into();
            self.follow_latest = true;
            self.auto_run = true;
            return Ok(());
        }
        if let Some(index) = most_recent_run_index(&self.catalog)
            && index != self.run_index
        {
            self.run_index = index;
            let loaded = read_snapshot_state(&self.data_dir, &self.summary().run_id)?;
            self.install_snapshot(loaded);
            self.selected_id.clone_from(&self.snapshot.root_session_id);
            self.detail_open = false;
        }
        self.cursor_ms = snapshot_bounds(&self.snapshot).1;
        self.playing = false;
        self.follow_latest = true;
        self.auto_run = true;
        self.notice = "LIVE FOLLOW".into();
        Ok(())
    }
}

fn preferred_reload_run_index(
    previous: &RunCatalog,
    current_id: &str,
    catalog: &RunCatalog,
    auto_run: bool,
    follow_latest: bool,
) -> Option<usize> {
    if auto_run && follow_latest {
        let newest_new = catalog
            .runs
            .iter()
            .enumerate()
            .filter(|(_, run)| !previous.runs.iter().any(|known| known.run_id == run.run_id))
            .max_by_key(|(_, run)| {
                (
                    parse_ms(run.last_activity_at.as_deref()).unwrap_or(i64::MIN),
                    run.event_count,
                )
            })
            .map(|(index, _)| index);
        if newest_new.is_some() {
            return newest_new;
        }
    }
    catalog
        .runs
        .iter()
        .position(|run| run.run_id == current_id)
        .or_else(|| most_recent_run_index(catalog))
}

fn most_recent_run_index(catalog: &RunCatalog) -> Option<usize> {
    catalog
        .runs
        .iter()
        .enumerate()
        .max_by_key(|(_, run)| {
            (
                parse_ms(run.last_activity_at.as_deref()).unwrap_or(i64::MIN),
                run.event_count,
            )
        })
        .map(|(index, _)| index)
}

fn discover_data_dir() -> PathBuf {
    let mut candidates = Vec::new();
    if let Some(value) = env::var_os("ORCHETRACE_DATA_DIR") {
        candidates.push(PathBuf::from(value));
    }
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join("Library/Application Support/dev.orchetrace.desktop/data"));
        candidates.push(home.join(".local/share/orchetrace/data"));
    }
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("apps/web/public/data"));
        candidates.push(cwd.join("data"));
    }
    candidates
        .into_iter()
        .find(|path| path.join("run-catalog.json").is_file())
        .unwrap_or_else(|| PathBuf::from("apps/web/public/data"))
}

fn read_catalog(data_dir: &Path) -> Result<RunCatalog, Box<dyn std::error::Error>> {
    let path = data_dir.join("run-catalog.json");
    let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
fn read_snapshot(data_dir: &Path, run_id: &str) -> Result<RunSnapshot, Box<dyn std::error::Error>> {
    Ok(read_snapshot_state(data_dir, run_id)?.snapshot)
}

fn read_snapshot_state(
    data_dir: &Path,
    run_id: &str,
) -> Result<SnapshotLoad, Box<dyn std::error::Error>> {
    let file = format!("run-{}.json", encode_file_component(run_id));
    let path = data_dir.join("runs").join(file);
    let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    let timeline_complete = value
        .get("timeline_paging")
        .and_then(|paging| paging.get("complete"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    Ok(SnapshotLoad {
        snapshot: serde_json::from_value(value)?,
        timeline_complete,
    })
}

fn load_full_timeline(
    data_dir: &Path,
    run_id: &str,
    snapshot: &mut RunSnapshot,
) -> Result<usize, Box<dyn std::error::Error>> {
    let file = format!("run-{}.json", encode_file_component(run_id));
    let path = data_dir.join("runs").join(file);
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
    let paging = value
        .get("timeline_paging")
        .ok_or("snapshot has no timeline paging metadata")?;
    let page_count = paging
        .get("page_count")
        .and_then(serde_json::Value::as_u64)
        .ok_or("timeline page count is missing")? as usize;
    let total_entries = paging
        .get("total_entries")
        .and_then(serde_json::Value::as_u64)
        .ok_or("timeline total entries is missing")? as usize;
    let directory = data_dir
        .join("timelines")
        .join(format!("run-{}", encode_file_component(run_id)));
    let mut timeline = Vec::with_capacity(total_entries);
    for page in 0..page_count {
        let page_path = directory.join(format!("page-{page:06}.json"));
        let bytes =
            fs::read(&page_path).map_err(|error| format!("{}: {error}", page_path.display()))?;
        let mut entries: Vec<TimelineEntry> = serde_json::from_slice(&bytes)?;
        timeline.append(&mut entries);
    }
    if timeline.len() != total_entries {
        return Err(format!(
            "timeline expected {total_entries} entries, received {}",
            timeline.len()
        )
        .into());
    }
    snapshot.timeline = timeline;
    Ok(total_entries)
}

fn encode_file_component(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn parse_ms(value: Option<&str>) -> Option<i64> {
    DateTime::parse_from_rfc3339(value?)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn snapshot_bounds(snapshot: &RunSnapshot) -> (i64, i64) {
    let mut times = Vec::new();
    for value in [
        snapshot.started_at.as_deref(),
        snapshot.last_activity_at.as_deref(),
    ] {
        if let Some(time) = parse_ms(value) {
            times.push(time);
        }
    }
    for item in &snapshot.timeline {
        if let Some(time) = parse_ms(Some(&item.at)) {
            times.push(time);
        }
    }
    let start = times.iter().copied().min().unwrap_or(0);
    let end = times.iter().copied().max().unwrap_or(start + 1);
    (start, end.max(start + 1))
}

fn build_token_index(timeline: &[TimelineEntry]) -> TokenUsageIndex {
    let mut index = TokenUsageIndex::new();
    for item in timeline {
        let (Some(at), Some(usage)) = (parse_ms(Some(&item.at)), item.token_usage.as_ref()) else {
            continue;
        };
        let entries = index.entry(item.session_id.clone()).or_default();
        let mut cumulative = entries
            .last()
            .map(|(_, usage)| usage.clone())
            .unwrap_or_default();
        merge_token_usage(&mut cumulative, usage);
        entries.push((at, cumulative));
    }
    index
}

fn snapshot_at(
    snapshot: &RunSnapshot,
    cursor: i64,
    token_index: &TokenUsageIndex,
) -> Vec<AgentSnapshot> {
    let mut agents = snapshot
        .agents
        .iter()
        .filter(|agent| {
            agent.id == snapshot.root_session_id
                || parse_ms(agent.started_at.as_deref()).is_none_or(|time| time <= cursor)
        })
        .map(|agent| agent_at(agent, &snapshot.timeline, cursor, token_index))
        .collect::<Vec<_>>();
    populate_subtree_usage(&mut agents);
    agents
}

fn agent_at(
    agent: &AgentSnapshot,
    timeline: &[TimelineEntry],
    cursor: i64,
    token_index: &TokenUsageIndex,
) -> AgentSnapshot {
    let mut view = agent.clone();
    if parse_ms(agent.last_activity_at.as_deref()).is_some_and(|time| time > cursor) {
        view.token_usage = token_index
            .get(&agent.id)
            .and_then(|entries| {
                let count = entries.partition_point(|(at, _)| *at <= cursor);
                count.checked_sub(1).map(|index| entries[index].1.clone())
            })
            .unwrap_or_default();
    }
    view.activations.retain(|activation| {
        parse_ms(Some(&activation.started_at)).is_none_or(|time| time <= cursor)
    });
    for activation in &mut view.activations {
        if parse_ms(activation.ended_at.as_deref()).is_some_and(|time| time > cursor) {
            activation.ended_at = None;
            activation.end_status = None;
        }
    }
    view.tools
        .retain(|tool| tool_start(tool, agent).is_none_or(|time| time <= cursor));
    for tool in &mut view.tools {
        if parse_ms(tool.ended_at.as_deref()).is_some_and(|time| time > cursor) {
            tool.ended_at = None;
            tool.outcome = None;
            tool.duration_ms = None;
            tool.output_summary = None;
        }
    }
    let active_tool = view.tools.iter().rev().find(|tool| tool.ended_at.is_none());
    let active_activation = view
        .activations
        .iter()
        .rev()
        .find(|activation| activation.ended_at.is_none());
    if active_tool.is_some() || active_activation.is_some() {
        view.status = orchetrace_protocol::ActivityStatus::Running;
        view.last_activity_at =
            DateTime::from_timestamp_millis(cursor).map(|time| time.to_rfc3339());
    }
    let outcome = timeline.iter().rev().find(|item| {
        item.session_id == agent.id
            && item.kind == "outcome"
            && parse_ms(Some(&item.at)).is_some_and(|time| time <= cursor)
    });
    if outcome.is_none()
        && parse_ms(agent.last_activity_at.as_deref()).is_some_and(|time| time > cursor)
    {
        view.outcome = None;
        view.outcome_evidence = None;
    }
    view.current_tool = active_tool.map(|tool| tool.name.clone());
    view.tool_count = view.tools.len();
    view.failed_tool_count = view
        .tools
        .iter()
        .filter(|tool| {
            matches!(
                tool.outcome,
                Some(orchetrace_protocol::TerminalOutcome::Failed)
            )
        })
        .count();
    view
}

fn populate_subtree_usage(agents: &mut [AgentSnapshot]) {
    let indexes = agents
        .iter()
        .enumerate()
        .map(|(index, agent)| (agent.id.clone(), index))
        .collect::<BTreeMap<_, _>>();
    for agent in agents.iter_mut() {
        agent.subtree_token_usage.clone_from(&agent.token_usage);
    }
    for child_index in (0..agents.len()).rev() {
        let Some(parent_index) = agents[child_index]
            .parent_id
            .as_ref()
            .and_then(|id| indexes.get(id))
            .copied()
        else {
            continue;
        };
        let usage = agents[child_index].subtree_token_usage.clone();
        merge_token_usage(&mut agents[parent_index].subtree_token_usage, &usage);
    }
}

fn merge_token_usage(total: &mut TokenUsageSnapshot, usage: &TokenUsageSnapshot) {
    total.input_tokens = total.input_tokens.saturating_add(usage.input_tokens);
    total.output_tokens = total.output_tokens.saturating_add(usage.output_tokens);
    total.cached_input_tokens = total
        .cached_input_tokens
        .saturating_add(usage.cached_input_tokens);
    total.cache_write_tokens = total
        .cache_write_tokens
        .saturating_add(usage.cache_write_tokens);
    total.reasoning_output_tokens = total
        .reasoning_output_tokens
        .saturating_add(usage.reasoning_output_tokens);
    total.total_tokens = total.total_tokens.saturating_add(usage.total_tokens);
    total.reports = total.reports.saturating_add(usage.reports);
}

fn session_token_usage(agents: &[AgentSnapshot]) -> TokenUsageSnapshot {
    let mut usage = TokenUsageSnapshot::default();
    for agent in agents {
        merge_token_usage(&mut usage, &agent.token_usage);
    }
    usage
}

fn tool_start(tool: &ToolSnapshot, agent: &AgentSnapshot) -> Option<i64> {
    parse_ms(
        tool.started_at
            .as_deref()
            .or(tool.ended_at.as_deref())
            .or(agent.started_at.as_deref()),
    )
}

fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let Some((header, graph, timeline, footer)) = screen_regions(area, app.snapshot.agents.len())
    else {
        frame.render_widget(
            Paragraph::new("orche needs at least 64×20 terminal cells")
                .style(Style::default().fg(ACCENT))
                .block(Block::default().borders(Borders::ALL).title(" orche ")),
            area,
        );
        return;
    };
    draw_header(frame, header, app);
    draw_graph(frame, graph, app);
    draw_timeline(frame, timeline, app);
    draw_footer(frame, footer, app);
    if app.detail_open {
        draw_detail(frame, graph, app);
    }
    if app.help_open {
        draw_help(frame, area);
    }
    if app.session_dialog.is_some() {
        draw_session_dialog(frame, area, app);
    }
}

fn screen_regions(area: Rect, agent_count: usize) -> Option<(Rect, Rect, Rect, Rect)> {
    if area.width < 64 || area.height < 20 {
        return None;
    }
    let timeline_height = (agent_count.min(6) as u16 + 6).clamp(8, (area.height / 3).max(8));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(8),
            Constraint::Length(timeline_height),
            Constraint::Length(1),
        ])
        .split(area);
    Some((chunks[0], chunks[1], chunks[2], chunks[3]))
}

fn contains(area: Rect, x: u16, y: u16) -> bool {
    x >= area.x && x < area.right() && y >= area.y && y < area.bottom()
}

fn draw_header(frame: &mut Frame, area: Rect, app: &App) {
    if !app.has_runs() {
        let header = Line::from(vec![
            Span::styled(
                " orche ",
                Style::default().fg(Color::Black).bg(ACCENT).bold(),
            ),
            Span::styled(" SESSION ", Style::default().fg(MUTED)),
            Span::styled("—", Style::default().fg(TEXT).bold()),
            Span::styled(
                "  0 sessions · waiting for Agent activity",
                Style::default().fg(MUTED),
            ),
        ]);
        frame.render_widget(
            Paragraph::new(header).block(Block::default().borders(Borders::BOTTOM)),
            area,
        );
        return;
    }
    let summary = app.summary();
    let time = format_clock(app.cursor_ms);
    let header = Line::from(vec![
        Span::styled(
            " orche ",
            Style::default().fg(Color::Black).bg(ACCENT).bold(),
        ),
        Span::styled(" SESSION ", Style::default().fg(MUTED)),
        Span::styled(&summary.label, Style::default().fg(TEXT).bold()),
        Span::styled(
            format!(
                "  {}  {}/{} sessions · {} agents · {} events",
                runtime_label(summary),
                app.run_index + 1,
                app.catalog.runs.len(),
                summary.agent_count,
                summary.event_count
            ),
            Style::default().fg(MUTED),
        ),
        Span::styled(format!("  {time} "), Style::default().fg(ACCENT)),
    ]);
    frame.render_widget(
        Paragraph::new(header).block(Block::default().borders(Borders::BOTTOM)),
        area,
    );
}

fn draw_graph(frame: &mut Frame, area: Rect, app: &App) {
    let playback_state = if app.playing {
        format!("PLAY {}", app.playback_speed_label())
    } else {
        app.notice.clone()
    };
    frame.render_widget(
        Block::default()
            .borders(Borders::BOTTOM)
            .title(format!(" topology · {playback_state} "))
            .title_style(Style::default().fg(MUTED))
            .style(Style::default().bg(CANVAS)),
        area,
    );
    let inner = area.inner(ratatui::layout::Margin {
        horizontal: 1,
        vertical: 1,
    });
    let agents = app.visible_agents();
    if agents.is_empty() {
        frame.render_widget(
            Paragraph::new("Waiting for the first observed Agent event…")
                .style(Style::default().fg(MUTED)),
            inner,
        );
        return;
    }
    draw_graph_grid(frame.buffer_mut(), inner);
    let positions = graph_positions(&agents, inner);
    draw_edges(frame.buffer_mut(), &agents, &positions);
    for rect in positions.values().copied() {
        draw_card_shadow(frame.buffer_mut(), rect, inner);
    }
    for agent in &agents {
        let Some(rect) = positions.get(&agent.id).copied() else {
            continue;
        };
        let selected = agent.id == app.selected_id;
        let state = agent_state(agent);
        let color = state_color(state);
        let title = truncate(&agent.label, rect.width.saturating_sub(4) as usize);
        let summary = latest_agent_event(&app.snapshot, &agent.id, app.cursor_ms)
            .map(|item| item.label.as_str())
            .or(agent.role.as_deref())
            .unwrap_or("agent activity");
        let lines = vec![
            Line::from(vec![
                Span::styled(state_glyph(state), Style::default().fg(color)),
                Span::styled(format!(" {title}"), Style::default().fg(TEXT).bold()),
            ]),
            Line::from(Span::styled(
                truncate(summary, rect.width.saturating_sub(2) as usize),
                Style::default().fg(MUTED),
            )),
            Line::from(vec![
                Span::styled(format!("{state:<7}"), Style::default().fg(color)),
                Span::styled(
                    truncate(
                        &format!(
                            "{} tools · {} / Σ{}",
                            agent.tool_count,
                            format_tokens(agent.token_usage.total_tokens),
                            format_tokens(agent.subtree_token_usage.total_tokens)
                        ),
                        rect.width.saturating_sub(10) as usize,
                    ),
                    Style::default().fg(if agent.failed_tool_count > 0 {
                        RED
                    } else {
                        MUTED
                    }),
                ),
            ]),
        ];
        let border = if selected {
            ACCENT
        } else if matches!(state, "running" | "ready") {
            Color::Rgb(74, 154, 86)
        } else {
            BORDER
        };
        frame.render_widget(
            Paragraph::new(lines).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(border))
                    .style(Style::default().bg(PANEL)),
            ),
            rect,
        );
    }
    draw_minimap(frame, inner, &agents, &positions, &app.selected_id);
}

fn draw_graph_grid(buffer: &mut Buffer, area: Rect) {
    for y in area.y..area.bottom() {
        for x in area.x..area.right() {
            if (x.saturating_sub(area.x)) % 8 == 2 && (y.saturating_sub(area.y)) % 4 == 1 {
                put(buffer, x, y, '·', Style::default().fg(GRID).bg(CANVAS));
            }
        }
    }
}

fn draw_card_shadow(buffer: &mut Buffer, rect: Rect, bounds: Rect) {
    let shadow = Style::default()
        .fg(Color::Rgb(18, 19, 17))
        .bg(Color::Rgb(18, 19, 17));
    let x = rect.right();
    if x < bounds.right() {
        for y in rect.y.saturating_add(1)..rect.bottom().min(bounds.bottom()) {
            put(buffer, x, y, ' ', shadow);
        }
    }
    let y = rect.bottom();
    if y < bounds.bottom() {
        for x in rect.x.saturating_add(1)..=rect.right().min(bounds.right().saturating_sub(1)) {
            put(buffer, x, y, ' ', shadow);
        }
    }
}

fn latest_agent_event<'a>(
    snapshot: &'a RunSnapshot,
    agent_id: &str,
    cursor_ms: i64,
) -> Option<&'a TimelineEntry> {
    snapshot
        .timeline
        .iter()
        .filter(|item| {
            item.session_id == agent_id
                && parse_ms(Some(&item.at)).is_some_and(|time| time <= cursor_ms)
        })
        .max_by_key(|item| {
            (
                parse_ms(Some(&item.at)).unwrap_or(i64::MIN),
                event_summary_priority(item),
            )
        })
}

fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}m tok", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}k tok", tokens as f64 / 1_000.0)
    } else {
        format!("{tokens} tok")
    }
}

fn draw_minimap(
    frame: &mut Frame,
    graph: Rect,
    agents: &[AgentSnapshot],
    positions: &BTreeMap<String, Rect>,
    selected_id: &str,
) {
    if graph.width < 36 || graph.height < 8 {
        return;
    }
    let width = (graph.width / 5).clamp(20, 30);
    let height = (graph.height / 3).clamp(7, 10);
    let area = Rect::new(graph.right().saturating_sub(width), graph.y, width, height);
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" map · {} ", agents.len()))
        .title_style(Style::default().fg(MUTED))
        .border_style(Style::default().fg(BORDER))
        .style(Style::default().bg(PANEL));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    let mut mini = BTreeMap::new();
    for agent in agents {
        let Some(card) = positions.get(&agent.id) else {
            continue;
        };
        let center_x = card.x + card.width / 2;
        let center_y = card.y + card.height / 2;
        let x = inner.x
            + center_x.saturating_sub(graph.x) * inner.width.saturating_sub(1) / graph.width.max(1);
        let y = inner.y
            + center_y.saturating_sub(graph.y) * inner.height.saturating_sub(1)
                / graph.height.max(1);
        mini.insert(agent.id.clone(), (x, y));
    }
    for agent in agents {
        let (Some(parent_id), Some(&(x2, y2))) = (&agent.parent_id, mini.get(&agent.id)) else {
            continue;
        };
        let Some(&(x1, y1)) = mini.get(parent_id) else {
            continue;
        };
        for x in x1.min(x2)..=x1.max(x2) {
            put(frame.buffer_mut(), x, y1, '─', Style::default().fg(BORDER));
        }
        for y in y1.min(y2)..=y1.max(y2) {
            put(frame.buffer_mut(), x2, y, '│', Style::default().fg(BORDER));
        }
    }
    for agent in agents {
        let Some(&(x, y)) = mini.get(&agent.id) else {
            continue;
        };
        let selected = agent.id == selected_id;
        put(
            frame.buffer_mut(),
            x,
            y,
            if selected { '◆' } else { '■' },
            Style::default().fg(if selected {
                ACCENT
            } else {
                state_color(agent_state(agent))
            }),
        );
    }
}

fn graph_positions(agents: &[AgentSnapshot], area: Rect) -> BTreeMap<String, Rect> {
    let by_id = agents
        .iter()
        .map(|agent| (agent.id.as_str(), agent))
        .collect::<BTreeMap<_, _>>();
    let mut levels = BTreeMap::<usize, Vec<&AgentSnapshot>>::new();
    for agent in agents {
        let mut depth = 0;
        let mut parent = agent.parent_id.as_deref();
        while let Some(id) = parent {
            depth += 1;
            parent = by_id.get(id).and_then(|item| item.parent_id.as_deref());
            if depth > agents.len() {
                break;
            }
        }
        levels.entry(depth).or_default().push(agent);
    }
    let input_order = agents
        .iter()
        .enumerate()
        .map(|(index, agent)| (agent.id.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    for level in levels.values_mut() {
        level.sort_by_key(|agent| hierarchy_order(agent, &by_id, &input_order));
    }
    let depth_count = levels.keys().max().copied().unwrap_or(0) + 1;
    let height_per_level = area.height / depth_count as u16;
    let card_height: u16 = if height_per_level >= 6 { 5 } else { 3 };
    let desired_step = card_height.saturating_add(3);
    let row_step = if depth_count <= 1 {
        0
    } else {
        desired_step.min(
            area.height
                .saturating_sub(card_height)
                .checked_div((depth_count - 1) as u16)
                .unwrap_or(1)
                .max(1),
        )
    };
    let used_height =
        card_height.saturating_add(row_step.saturating_mul(depth_count.saturating_sub(1) as u16));
    let top = area
        .y
        .saturating_add(area.height.saturating_sub(used_height) / 2);
    let mut positions = BTreeMap::new();
    for (depth, level) in levels {
        let count = level.len() as u16;
        let available = area.width.saturating_sub(2).max(1);
        let slot = (available / count.max(1)).max(1);
        let card_width = if depth == 0 {
            24.min(available)
        } else {
            slot.saturating_sub(1).clamp(10, 22).min(slot).max(1)
        };
        for (index, agent) in level.into_iter().enumerate() {
            let x = if depth == 0 {
                area.x
                    .saturating_add(area.width.saturating_sub(card_width) / 2)
            } else {
                let center = area.x + 1 + slot * index as u16 + slot / 2;
                center
                    .saturating_sub(card_width / 2)
                    .clamp(area.x, area.right().saturating_sub(card_width))
            };
            let y = top.saturating_add(depth as u16 * row_step);
            positions.insert(agent.id.clone(), Rect::new(x, y, card_width, card_height));
        }
    }
    positions
}

fn hierarchy_order(
    agent: &AgentSnapshot,
    by_id: &BTreeMap<&str, &AgentSnapshot>,
    input_order: &BTreeMap<&str, usize>,
) -> Vec<usize> {
    let mut order = vec![*input_order.get(agent.id.as_str()).unwrap_or(&usize::MAX)];
    let mut parent = agent.parent_id.as_deref();
    while let Some(parent_id) = parent {
        order.push(*input_order.get(parent_id).unwrap_or(&usize::MAX));
        parent = by_id
            .get(parent_id)
            .and_then(|item| item.parent_id.as_deref());
        if order.len() > by_id.len() {
            break;
        }
    }
    order.reverse();
    order
}

fn draw_edges(buffer: &mut Buffer, agents: &[AgentSnapshot], positions: &BTreeMap<String, Rect>) {
    let mut children = BTreeMap::<&str, Vec<&AgentSnapshot>>::new();
    for agent in agents {
        if let Some(parent_id) = agent.parent_id.as_deref()
            && positions.contains_key(parent_id)
            && positions.contains_key(&agent.id)
        {
            children.entry(parent_id).or_default().push(agent);
        }
    }
    let edge_style = Style::default().fg(Color::Rgb(79, 176, 94));
    let mut families = children.into_iter().collect::<Vec<_>>();
    families.sort_by_key(|(parent_id, _)| {
        positions
            .get(*parent_id)
            .map(|rect| rect.x)
            .unwrap_or(u16::MAX)
    });
    for (family_index, (parent_id, siblings)) in families.into_iter().enumerate() {
        let Some(parent) = positions.get(parent_id) else {
            continue;
        };
        let parent_x = parent.x + parent.width / 2;
        let parent_y = parent.bottom();
        let child_points = siblings
            .iter()
            .filter_map(|agent| {
                positions
                    .get(&agent.id)
                    .map(|rect| (rect.x + rect.width / 2, rect.y.saturating_sub(1)))
            })
            .collect::<Vec<_>>();
        let Some(min_child_y) = child_points.iter().map(|(_, y)| *y).min() else {
            continue;
        };
        if min_child_y <= parent_y {
            continue;
        }
        let gap = min_child_y.saturating_sub(parent_y);
        let trunk_levels = gap.saturating_sub(1).max(1);
        let trunk_y = parent_y + 1 + family_index as u16 % trunk_levels;
        for y in parent_y..=trunk_y {
            put(buffer, parent_x, y, '│', edge_style);
        }
        let min_x = child_points
            .iter()
            .map(|(x, _)| *x)
            .min()
            .unwrap_or(parent_x)
            .min(parent_x);
        let max_x = child_points
            .iter()
            .map(|(x, _)| *x)
            .max()
            .unwrap_or(parent_x)
            .max(parent_x);
        for x in min_x..=max_x {
            put(buffer, x, trunk_y, '─', edge_style);
        }
        put(buffer, parent_x, trunk_y, '┴', edge_style);
        for (child_x, child_y) in child_points {
            put(buffer, child_x, trunk_y, '┬', edge_style);
            for y in trunk_y.saturating_add(1)..=child_y {
                put(buffer, child_x, y, '│', edge_style);
            }
            put(buffer, child_x, child_y, '▼', edge_style);
        }
    }
}

fn put(buffer: &mut Buffer, x: u16, y: u16, symbol: char, style: Style) {
    if let Some(cell) = buffer.cell_mut(Position::new(x, y)) {
        cell.set_char(symbol).set_style(style);
    }
}

fn draw_timeline(frame: &mut Frame, area: Rect, app: &App) {
    if !app.has_runs() {
        frame.render_widget(
            Paragraph::new("No observed events yet. A new Session will appear automatically.")
                .style(Style::default().fg(MUTED))
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(" timeline · waiting ")
                        .title_style(Style::default().fg(ACCENT))
                        .style(Style::default().bg(PANEL)),
                ),
            area,
        );
        return;
    }
    let (start, end) = snapshot_bounds(&app.snapshot);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(
            " timeline · {} / {} · {} → {} ",
            format_elapsed(start, app.cursor_ms),
            format_elapsed(start, end),
            format_axis_time(start, end - start),
            format_axis_time(end, end - start)
        ))
        .title_style(Style::default().fg(ACCENT));
    let inner = block.inner(area);
    frame.render_widget(block.style(Style::default().bg(PANEL)), area);
    if inner.height == 0 {
        return;
    }
    let label_width = 14_u16.min(inner.width / 3);
    let track_x = inner.x + label_width;
    let track_width = inner.width.saturating_sub(label_width + 1).max(1);
    draw_latest_event(frame, inner, app);
    draw_event_markers(
        frame,
        inner.y.saturating_add(1),
        track_x,
        track_width,
        start,
        end,
        app,
    );
    let lane_y = inner.y.saturating_add(2);
    let max_lanes = inner.height.saturating_sub(3) as usize;
    let selected_index = app
        .snapshot
        .agents
        .iter()
        .position(|agent| agent.id == app.selected_id)
        .unwrap_or(0);
    let offset = selected_index
        .saturating_sub(max_lanes.saturating_sub(1))
        .min(app.snapshot.agents.len().saturating_sub(max_lanes));
    for (row, agent) in app
        .snapshot
        .agents
        .iter()
        .skip(offset)
        .take(max_lanes)
        .enumerate()
    {
        let y = lane_y + row as u16;
        let visible =
            parse_ms(agent.started_at.as_deref()).is_none_or(|time| time <= app.cursor_ms);
        let label_style = if agent.id == app.selected_id {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else if visible {
            Style::default().fg(TEXT)
        } else {
            Style::default().fg(Color::DarkGray)
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    format!("{} ", state_glyph(agent_state(agent))),
                    Style::default().fg(state_color(agent_state(agent))),
                ),
                Span::styled(
                    truncate(&agent.label, label_width.saturating_sub(3) as usize),
                    label_style,
                ),
            ])),
            Rect::new(inner.x, y, label_width.saturating_sub(1), 1),
        );
        for x in track_x..track_x + track_width {
            put(
                frame.buffer_mut(),
                x,
                y,
                if (x.saturating_sub(track_x)) % 4 == 0 {
                    '·'
                } else {
                    ' '
                },
                Style::default().fg(TRACK),
            );
        }
        for activation in &agent.activations {
            let from = parse_ms(Some(&activation.started_at)).unwrap_or(start);
            let to = parse_ms(activation.ended_at.as_deref()).unwrap_or(end);
            draw_interval(
                frame.buffer_mut(),
                track_x,
                y,
                track_width,
                start,
                end,
                from,
                to,
                app.cursor_ms,
                '━',
            );
        }
        for tool in &agent.tools {
            let from = tool_start(tool, agent).unwrap_or(start);
            let to = parse_ms(tool.ended_at.as_deref()).unwrap_or(end);
            draw_interval(
                frame.buffer_mut(),
                track_x,
                y,
                track_width,
                start,
                end,
                from,
                to,
                app.cursor_ms,
                '■',
            );
        }
        let mut cells = BTreeMap::<u16, (u8, char, Color)>::new();
        for item in app
            .snapshot
            .timeline
            .iter()
            .filter(|item| item.session_id == agent.id)
        {
            let Some(at) = parse_ms(Some(&item.at)) else {
                continue;
            };
            let x = track_x + time_x(at, start, end, track_width);
            let color = if at <= app.cursor_ms {
                event_color(item)
            } else {
                Color::DarkGray
            };
            let candidate = (event_priority(item), event_glyph(&item.kind), color);
            if cells.get(&x).is_none_or(|current| candidate.0 >= current.0) {
                cells.insert(x, candidate);
            }
        }
        for (x, (_, glyph, color)) in cells {
            put(frame.buffer_mut(), x, y, glyph, Style::default().fg(color));
        }
        let cursor_x = track_x + time_x(app.cursor_ms, start, end, track_width);
        put(
            frame.buffer_mut(),
            cursor_x,
            y,
            '┃',
            Style::default().fg(ACCENT).bold(),
        );
    }
    draw_time_ruler(frame, inner, track_x, track_width, start, end);
}

fn draw_event_markers(
    frame: &mut Frame,
    y: u16,
    track_x: u16,
    track_width: u16,
    start: i64,
    end: i64,
    app: &App,
) {
    if track_width == 0 {
        return;
    }
    frame.render_widget(
        Paragraph::new("events").style(Style::default().fg(MUTED)),
        Rect::new(track_x.saturating_sub(14), y, 13.min(track_x), 1),
    );
    for x in track_x..track_x + track_width {
        put(
            frame.buffer_mut(),
            x,
            y,
            if (x.saturating_sub(track_x)) % 8 == 0 {
                '·'
            } else {
                ' '
            },
            Style::default().fg(TRACK),
        );
    }
    let mut cells = BTreeMap::<u16, (u8, char, Color)>::new();
    for item in &app.snapshot.timeline {
        let Some(at) = parse_ms(Some(&item.at)) else {
            continue;
        };
        let x = track_x + time_x(at, start, end, track_width);
        let color = if at <= app.cursor_ms {
            event_color(item)
        } else {
            FUTURE
        };
        let candidate = (event_priority(item), event_marker_glyph(&item.kind), color);
        if cells.get(&x).is_none_or(|current| candidate.0 >= current.0) {
            cells.insert(x, candidate);
        }
    }
    for (x, (_, glyph, color)) in cells {
        put(frame.buffer_mut(), x, y, glyph, Style::default().fg(color));
    }
    let cursor_x = track_x + time_x(app.cursor_ms, start, end, track_width);
    put(
        frame.buffer_mut(),
        cursor_x,
        y,
        '┃',
        Style::default().fg(ACCENT).bold(),
    );
}

fn draw_latest_event(frame: &mut Frame, inner: Rect, app: &App) {
    if inner.height < 2 || inner.width == 0 {
        return;
    }
    let latest = latest_agent_event(&app.snapshot, &app.selected_id, app.cursor_ms);
    let content = latest.map_or_else(
        || " --:--:--  ·  waiting for Agent activity".to_owned(),
        |item| {
            format!(
                " {}  {}  {:<11} {}",
                format_clock(parse_ms(Some(&item.at)).unwrap_or(app.cursor_ms)),
                event_marker_glyph(&item.kind),
                item.kind,
                item.label
            )
        },
    );
    frame.render_widget(
        Paragraph::new(truncate(&content, inner.width as usize)).style(
            Style::default()
                .fg(TEXT)
                .bg(PANEL)
                .add_modifier(Modifier::BOLD),
        ),
        Rect::new(inner.x, inner.y, inner.width, 1),
    );
}

fn event_summary_priority(item: &TimelineEntry) -> u8 {
    match item.kind.as_str() {
        "error" => 9,
        "outcome" => 8,
        "tool" | "tool-result" => 7,
        "message" => 6,
        "spawn" => 5,
        "prompt" => 4,
        "reasoning" => 3,
        _ => 0,
    }
}

fn draw_time_ruler(
    frame: &mut Frame,
    inner: Rect,
    track_x: u16,
    track_width: u16,
    start: i64,
    end: i64,
) {
    if inner.height == 0 || track_width == 0 {
        return;
    }
    let y = inner.bottom().saturating_sub(1);
    for offset in 0..track_width {
        let glyph = if offset == 0 || offset == track_width.saturating_sub(1) || offset % 12 == 0 {
            '┬'
        } else {
            '─'
        };
        put(
            frame.buffer_mut(),
            track_x + offset,
            y,
            glyph,
            Style::default().fg(Color::Rgb(65, 66, 61)),
        );
    }

    let span = end.saturating_sub(start);
    let left = format_axis_time(start, span);
    let middle = format_axis_time(start + span / 2, span);
    let right = format_axis_time(end, span);
    let left_width = (left.chars().count() as u16).min(track_width);
    frame.render_widget(
        Paragraph::new(truncate(&left, left_width as usize)).style(Style::default().fg(MUTED)),
        Rect::new(track_x, y, left_width, 1),
    );
    let right_width = (right.chars().count() as u16).min(track_width);
    if left_width.saturating_add(right_width).saturating_add(1) <= track_width {
        frame.render_widget(
            Paragraph::new(right).style(Style::default().fg(MUTED)),
            Rect::new(track_x + track_width - right_width, y, right_width, 1),
        );
    }
    let middle_width = (middle.chars().count() as u16).min(track_width);
    if left_width
        .saturating_add(middle_width)
        .saturating_add(right_width)
        .saturating_add(4)
        <= track_width
    {
        frame.render_widget(
            Paragraph::new(middle).style(Style::default().fg(Color::DarkGray)),
            Rect::new(
                track_x + track_width / 2 - middle_width / 2,
                y,
                middle_width,
                1,
            ),
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_interval(
    buffer: &mut Buffer,
    track_x: u16,
    y: u16,
    width: u16,
    start: i64,
    end: i64,
    from: i64,
    to: i64,
    cursor: i64,
    symbol: char,
) {
    let left = track_x + time_x(from, start, end, width);
    let right = track_x + time_x(to, start, end, width);
    for x in left..=right {
        let at = start + ((x.saturating_sub(track_x)) as i64 * (end - start)) / width.max(1) as i64;
        let color = if at <= cursor { ACCENT } else { FUTURE };
        put(buffer, x, y, symbol, Style::default().fg(color));
    }
}

fn time_x(value: i64, start: i64, end: i64, width: u16) -> u16 {
    let span = (end - start).max(1);
    (((value - start).clamp(0, span) as f64 / span as f64) * width.saturating_sub(1) as f64).round()
        as u16
}

fn draw_footer(frame: &mut Frame, area: Rect, app: &App) {
    let session_tokens = session_token_usage(&app.visible_agents()).total_tokens;
    let mode = if app.playing {
        format!("Ⅱ pause {}", app.playback_speed_label())
    } else if app.follow_latest && app.auto_run {
        "● live".into()
    } else if app.follow_latest {
        "◆ latest".into()
    } else {
        format!("▶ play {}", app.playback_speed_label())
    };
    let line = Line::from(vec![
        Span::styled(
            " orche ",
            Style::default().fg(Color::Black).bg(ACCENT).bold(),
        ),
        Span::styled(format!(" {mode} "), Style::default().fg(ACCENT)),
        Span::styled(
            format!("{}  ", format_clock(app.cursor_ms)),
            Style::default().fg(MUTED),
        ),
        Span::styled(
            truncate(
                &format!(
                    "{} · {} session tokens · ↑↓ agent/session · Tab session · ←→ time · e rename · d delete · q quit",
                    app.observer_status,
                    format_tokens(session_tokens)
                ),
                area.width.saturating_sub(28) as usize,
            ),
            Style::default().fg(MUTED),
        ),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

fn draw_detail(frame: &mut Frame, graph: Rect, app: &App) {
    let Some((agent, lines)) = detail_content(app) else {
        return;
    };
    let area = detail_area(graph);
    frame.render_widget(Clear, area);
    let maximum = detail_scroll_limit_for_lines(area, &lines);
    let scroll = app.detail_scroll.min(maximum);
    let scroll_hint = if maximum > 0 {
        format!(" · ↕ {scroll}/{maximum}")
    } else {
        String::new()
    };
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .scroll((scroll, 0))
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT))
                    .title(format!(" {}{scroll_hint} · esc × ", agent.label))
                    .style(Style::default().bg(PANEL)),
            ),
        area,
    );
}

fn detail_area(graph: Rect) -> Rect {
    let width = (graph.width / 2).clamp(38, 70).min(graph.width);
    Rect::new(
        graph.right().saturating_sub(width),
        graph.y,
        width,
        graph.height,
    )
}

fn detail_content(app: &App) -> Option<(AgentSnapshot, Vec<Line<'static>>)> {
    let agent = app
        .visible_agents()
        .into_iter()
        .find(|agent| agent.id == app.selected_id)?;
    let events = app
        .snapshot
        .timeline
        .iter()
        .filter(|item| {
            item.session_id == agent.id
                && parse_ms(Some(&item.at)).is_some_and(|time| time <= app.cursor_ms)
        })
        .collect::<Vec<_>>();
    let usage = &agent.token_usage;
    let subtree_usage = &agent.subtree_token_usage;
    let session_usage = session_token_usage(&app.visible_agents());
    let mut lines = vec![
        Line::from(vec![
            Span::styled(
                agent_state(&agent),
                Style::default().fg(state_color(agent_state(&agent))).bold(),
            ),
            Span::styled(
                format!(
                    "  {}  {} tools",
                    agent.model.as_deref().unwrap_or("unknown"),
                    agent.tool_count
                ),
                Style::default().fg(MUTED),
            ),
        ]),
        Line::from(Span::styled(
            format!("id {}", agent.id),
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(vec![
            Span::styled("self     ", Style::default().fg(MUTED)),
            Span::styled(
                format_tokens(usage.total_tokens),
                Style::default().fg(ACCENT).bold(),
            ),
            Span::styled(
                format!(
                    " · in {} · out {} · cached {} · write {}",
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.cached_input_tokens,
                    usage.cache_write_tokens
                ),
                Style::default().fg(MUTED),
            ),
        ]),
        Line::from(vec![
            Span::styled("subtree  ", Style::default().fg(MUTED)),
            Span::styled(
                format_tokens(subtree_usage.total_tokens),
                Style::default().fg(GREEN).bold(),
            ),
            Span::styled(" · inclusive descendants", Style::default().fg(MUTED)),
        ]),
        Line::from(vec![
            Span::styled("session  ", Style::default().fg(MUTED)),
            Span::styled(
                format_tokens(session_usage.total_tokens),
                Style::default().fg(ACCENT).bold(),
            ),
            Span::styled(" · all Agent self usage", Style::default().fg(MUTED)),
        ]),
        Line::from(""),
        Line::from(Span::styled("triggered by", Style::default().fg(MUTED))),
    ];
    for item in events.iter().filter(|item| {
        matches!(
            item.kind.as_str(),
            "prompt" | "reasoning" | "message" | "error"
        )
    }) {
        lines.push(detail_line(item));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "tool calls",
        Style::default().fg(MUTED),
    )));
    for item in events.iter().filter(|item| item.kind.starts_with("tool")) {
        lines.push(detail_line(item));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "status evidence",
        Style::default().fg(MUTED),
    )));
    lines.push(Line::from(Span::styled(
        agent
            .outcome_evidence
            .clone()
            .unwrap_or_else(|| "No terminal outcome was recorded at this time.".into()),
        Style::default().fg(Color::Gray),
    )));
    Some((agent, lines))
}

fn detail_scroll_limit(graph: Rect, app: &App) -> u16 {
    detail_content(app)
        .map(|(_, lines)| detail_scroll_limit_for_lines(detail_area(graph), &lines))
        .unwrap_or_default()
}

fn detail_scroll_limit_for_lines(area: Rect, lines: &[Line<'_>]) -> u16 {
    let width = area.width.saturating_sub(2).max(1) as usize;
    let visible = area.height.saturating_sub(2) as usize;
    let rendered = lines
        .iter()
        .map(|line| line.width().max(1).div_ceil(width))
        .sum::<usize>();
    rendered.saturating_sub(visible).min(u16::MAX as usize) as u16
}

fn detail_line(item: &TimelineEntry) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("{} {:<9}", event_glyph(&item.kind), item.kind),
            Style::default().fg(event_color(item)),
        ),
        Span::styled(item.label.clone(), Style::default().fg(TEXT)),
        Span::styled(
            format!("  {}", format_clock(parse_ms(Some(&item.at)).unwrap_or(0))),
            Style::default().fg(MUTED),
        ),
    ])
}

fn draw_help(frame: &mut Frame, area: Rect) {
    let width = 58.min(area.width.saturating_sub(4));
    let height = 22.min(area.height.saturating_sub(2));
    let popup = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Paragraph::new(
            "Click select Agent and open detail\nWheel over detail to scroll its content\nClick timeline to seek real time\n↑/↓  select Agent / adjacent session\nTab   next session (Shift+Tab previous)\nEnter open/close detail\n←/→  move real-time cursor\nHome/End first/latest state\nSpace play/pause at selected speed\n, / . slower/faster playback\n[ / ] previous/next session\nf     follow newest live session\nr     reload from disk\ne     rename current session\nd     delete current session\nq     quit\n\nPress any key to close",
        )
        .style(Style::default().fg(TEXT))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(ACCENT))
                .title(" orche help ")
                .style(Style::default().bg(PANEL)),
        ),
        popup,
    );
}

fn draw_session_dialog(frame: &mut Frame, area: Rect, app: &App) {
    let Some(dialog) = app.session_dialog.as_ref() else {
        return;
    };
    let width = 70.min(area.width.saturating_sub(4)).max(36);
    let height = match dialog {
        SessionDialog::Rename { .. } => 8,
        SessionDialog::DeleteConfirm => 9,
    }
    .min(area.height.saturating_sub(2));
    let popup = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, popup);
    let (title, border, body) = match dialog {
        SessionDialog::Rename { value } => (
            " rename session ",
            ACCENT,
            Text::from(vec![
                Line::from(Span::styled(
                    format!("ID  {}", app.summary().root_session_id),
                    Style::default().fg(MUTED),
                )),
                Line::from(""),
                Line::from(vec![
                    Span::styled("name  ", Style::default().fg(ACCENT)),
                    Span::styled(value, Style::default().fg(TEXT).bold()),
                    Span::styled("▌", Style::default().fg(ACCENT)),
                ]),
                Line::from(Span::styled(
                    "Enter save · Esc cancel · ID and runtime data stay unchanged",
                    Style::default().fg(MUTED),
                )),
            ]),
        ),
        SessionDialog::DeleteConfirm => (
            " delete session ",
            RED,
            Text::from(vec![
                Line::from(Span::styled(
                    app.summary().label.clone(),
                    Style::default().fg(TEXT).bold(),
                )),
                Line::from(Span::styled(
                    format!("ID  {}", app.summary().root_session_id),
                    Style::default().fg(MUTED),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    format!(
                        "Delete {} Agents and {} canonical events?",
                        app.summary().agent_count,
                        app.summary().event_count
                    ),
                    Style::default().fg(RED),
                )),
                Line::from("Y / Enter confirm · N / Esc cancel"),
            ]),
        ),
    };
    frame.render_widget(
        Paragraph::new(body).wrap(Wrap { trim: false }).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(border))
                .title(title)
                .style(Style::default().bg(PANEL)),
        ),
        popup,
    );
}

fn runtime_label(summary: &RunSummary) -> String {
    orchetrace_protocol::runtime_descriptor(summary.runtime.as_str())
        .map(|descriptor| descriptor.short_label)
        .unwrap_or_else(|| summary.runtime.as_str())
        .to_owned()
}

fn agent_state(agent: &AgentSnapshot) -> &'static str {
    if let Some(outcome) = &agent.outcome {
        return match outcome {
            orchetrace_protocol::TerminalOutcome::Succeeded => "done",
            orchetrace_protocol::TerminalOutcome::Failed => "failed",
            orchetrace_protocol::TerminalOutcome::Interrupted => "stopped",
            orchetrace_protocol::TerminalOutcome::Cancelled => "cancelled",
            orchetrace_protocol::TerminalOutcome::Unavailable => "unavailable",
        };
    }
    match agent.status {
        orchetrace_protocol::ActivityStatus::Running => "running",
        orchetrace_protocol::ActivityStatus::Ready => "ready",
        orchetrace_protocol::ActivityStatus::Waiting => "waiting",
        orchetrace_protocol::ActivityStatus::Idle => "idle",
        orchetrace_protocol::ActivityStatus::Inactive => "inactive",
        orchetrace_protocol::ActivityStatus::Unknown => "unknown",
    }
}

fn state_color(state: &str) -> Color {
    match state {
        "running" | "ready" | "done" => GREEN,
        "failed" => RED,
        "waiting" => ACCENT,
        _ => MUTED,
    }
}

fn state_glyph(state: &str) -> &'static str {
    match state {
        "running" => "●",
        "ready" => "◆",
        "done" => "✓",
        "failed" => "×",
        "waiting" => "◐",
        _ => "○",
    }
}

fn event_glyph(kind: &str) -> char {
    match kind {
        "prompt" => '>',
        "reasoning" => '~',
        "message" => 'm',
        "tool" => '*',
        "tool-result" => '+',
        "outcome" => '!',
        "error" => 'x',
        "spawn" => 'o',
        _ => '.',
    }
}

fn event_marker_glyph(kind: &str) -> char {
    match kind {
        "prompt" => '◆',
        "reasoning" => '›',
        "message" => '✦',
        "tool" => '♟',
        "tool-result" => '✓',
        "outcome" => '◆',
        "error" => '×',
        "spawn" => '◇',
        "turn" | "lifecycle" => '◆',
        _ => '·',
    }
}

fn event_priority(item: &TimelineEntry) -> u8 {
    if item.kind == "error"
        || matches!(
            item.outcome,
            Some(orchetrace_protocol::TerminalOutcome::Failed)
        )
    {
        6
    } else {
        match item.kind.as_str() {
            "outcome" => 5,
            "spawn" => 4,
            "tool-result" => 3,
            "tool" => 2,
            "prompt" | "reasoning" | "message" => 1,
            _ => 0,
        }
    }
}

fn event_color(item: &TimelineEntry) -> Color {
    if item.kind == "error"
        || matches!(
            item.outcome,
            Some(orchetrace_protocol::TerminalOutcome::Failed)
        )
    {
        RED
    } else if item.kind == "spawn" {
        GREEN
    } else {
        ACCENT
    }
}

fn format_clock(value: i64) -> String {
    DateTime::from_timestamp_millis(value)
        .map(|time| time.with_timezone(&Local).format("%H:%M:%S").to_string())
        .unwrap_or_else(|| "--:--:--".into())
}

fn format_elapsed(start: i64, value: i64) -> String {
    let millis = value.saturating_sub(start).max(0);
    if millis < 1_000 {
        format!("{millis}ms")
    } else if millis < 60_000 {
        format!("{:.1}s", millis as f64 / 1_000.0)
    } else if millis < 3_600_000 {
        format!("{}m {:02}s", millis / 60_000, (millis % 60_000) / 1_000)
    } else if millis < 86_400_000 {
        format!(
            "{}h {:02}m",
            millis / 3_600_000,
            (millis % 3_600_000) / 60_000
        )
    } else {
        format!(
            "{}d {:02}h",
            millis / 86_400_000,
            (millis % 86_400_000) / 3_600_000
        )
    }
}

fn scale_playback_elapsed(elapsed_ms: i64, speed: f64) -> i64 {
    (elapsed_ms as f64 * speed) as i64
}

fn format_axis_time(value: i64, span: i64) -> String {
    DateTime::from_timestamp_millis(value)
        .map(|time| {
            let time = time.with_timezone(&Local);
            if span >= 86_400_000 {
                time.format("%m-%d %H:%M").to_string()
            } else {
                time.format("%H:%M:%S").to_string()
            }
        })
        .unwrap_or_else(|| "--:--:--".into())
}

fn truncate(value: &str, width: usize) -> String {
    let count = value.chars().count();
    if count <= width {
        return value.to_owned();
    }
    if width <= 1 {
        return "…".into();
    }
    value.chars().take(width - 1).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_data_dir(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("orche-{name}-{}-{unique}", std::process::id()))
    }

    fn summary(run_id: &str, last_activity_at: &str, event_count: usize) -> RunSummary {
        RunSummary {
            run_id: run_id.into(),
            root_session_id: format!("{run_id}-root"),
            source_id: "test".into(),
            runtime: orchetrace_protocol::RuntimeKind::Codex,
            label: run_id.into(),
            status: orchetrace_protocol::ActivityStatus::Running,
            outcome: None,
            agent_count: 1,
            edge_count: 0,
            event_count,
            started_at: Some("2026-08-31T00:00:00Z".into()),
            last_activity_at: Some(last_activity_at.into()),
        }
    }

    #[test]
    fn empty_catalog_stays_open_and_waits_for_a_new_session() {
        let data_dir = temporary_data_dir("empty-catalog");
        fs::create_dir_all(&data_dir).unwrap();
        let catalog = RunCatalog {
            schema_version: 1,
            pending_event_count: 0,
            runs: Vec::new(),
        };
        fs::write(
            data_dir.join("run-catalog.json"),
            serde_json::to_vec(&catalog).unwrap(),
        )
        .unwrap();

        let mut app = App::load(
            data_dir.clone(),
            None,
            Duration::from_millis(10),
            "TEST".into(),
        )
        .unwrap();

        assert!(!app.has_runs());
        assert!(!app.quit);
        assert_eq!(app.notice, "WAITING FOR SESSION");
        assert!(app.snapshot.agents.is_empty());
        app.reload(false).unwrap();
        assert!(!app.quit);

        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn arguments_accept_terminal_data_source() {
        let args = Args::parse([
            "--data-dir".into(),
            "/tmp/orche".into(),
            "--refresh-ms".into(),
            "20".into(),
        ])
        .unwrap();
        assert_eq!(args.data_dir, Some(PathBuf::from("/tmp/orche")));
        assert_eq!(args.refresh, Duration::from_millis(100));
    }

    #[test]
    fn arguments_accept_runtime_hook_management() {
        let args = Args::parse(["hooks".into(), "agy".into(), "status".into()]).unwrap();
        let hooks = args.hooks.unwrap();
        assert_eq!(hooks.runtime, "agy");
        assert_eq!(hooks.action, "status");
    }

    #[test]
    fn run_ids_use_the_same_utf8_hex_file_names_as_ingest() {
        assert_eq!(encode_file_component("pi:会话"), "70693ae4bc9ae8af9d");
    }

    #[test]
    fn time_axis_maps_both_bounds() {
        assert_eq!(time_x(1_000, 1_000, 2_000, 101), 0);
        assert_eq!(time_x(2_000, 1_000, 2_000, 101), 100);
    }

    #[test]
    fn elapsed_time_stays_readable_for_long_lived_sessions() {
        assert_eq!(format_elapsed(0, 834 * 60_000 + 45_000), "13h 54m");
        assert_eq!(format_elapsed(0, 5 * 86_400_000 + 19 * 3_600_000), "5d 19h");
    }

    #[test]
    fn playback_speed_scales_real_elapsed_time() {
        assert_eq!(scale_playback_elapsed(1_000, 0.25), 250);
        assert_eq!(scale_playback_elapsed(1_000, 1.0), 1_000);
        assert_eq!(scale_playback_elapsed(1_000, 8.0), 8_000);
    }

    #[test]
    fn token_prefix_index_returns_usage_at_the_historical_cursor() {
        let timeline = vec![
            TimelineEntry {
                session_id: "agent".into(),
                at: "2026-08-31T00:00:01Z".into(),
                kind: "usage".into(),
                label: "first".into(),
                outcome: None,
                token_usage: Some(TokenUsageSnapshot {
                    input_tokens: 10,
                    total_tokens: 10,
                    reports: 1,
                    ..TokenUsageSnapshot::default()
                }),
            },
            TimelineEntry {
                session_id: "agent".into(),
                at: "2026-08-31T00:00:03Z".into(),
                kind: "usage".into(),
                label: "second".into(),
                outcome: None,
                token_usage: Some(TokenUsageSnapshot {
                    output_tokens: 5,
                    total_tokens: 5,
                    reports: 1,
                    ..TokenUsageSnapshot::default()
                }),
            },
        ];
        let index = build_token_index(&timeline);
        let entries = &index["agent"];
        let cursor = parse_ms(Some("2026-08-31T00:00:02Z")).unwrap();
        let count = entries.partition_point(|(at, _)| *at <= cursor);

        assert_eq!(entries[count - 1].1.total_tokens, 10);
        assert_eq!(entries.last().unwrap().1.total_tokens, 15);
        assert_eq!(entries.last().unwrap().1.reports, 2);
    }

    #[test]
    fn paged_timeline_is_loaded_only_when_full_history_is_requested() {
        let fixture_dir =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/public/data");
        let run_id = "deepseek-harness:10:local-demo:8:run-root";
        let source = read_snapshot(&fixture_dir, run_id).unwrap();
        let expected = source.timeline.clone();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data_dir =
            std::env::temp_dir().join(format!("orche-timeline-{}-{nonce}", std::process::id()));
        let page_dir = data_dir
            .join("timelines")
            .join(format!("run-{}", encode_file_component(run_id)));
        fs::create_dir_all(data_dir.join("runs")).unwrap();
        fs::create_dir_all(&page_dir).unwrap();

        let midpoint = expected.len() / 2;
        let mut value = serde_json::to_value(&source).unwrap();
        value["timeline"] = serde_json::to_value(&expected[..1]).unwrap();
        value["timeline_paging"] = serde_json::json!({
            "total_entries": expected.len(),
            "page_size": midpoint,
            "page_count": 2,
            "complete": false
        });
        fs::write(
            data_dir
                .join("runs")
                .join(format!("run-{}.json", encode_file_component(run_id))),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        fs::write(
            page_dir.join("page-000000.json"),
            serde_json::to_vec(&expected[..midpoint]).unwrap(),
        )
        .unwrap();
        fs::write(
            page_dir.join("page-000001.json"),
            serde_json::to_vec(&expected[midpoint..]).unwrap(),
        )
        .unwrap();

        let loaded = read_snapshot_state(&data_dir, run_id).unwrap();
        assert!(!loaded.timeline_complete);
        assert_eq!(loaded.snapshot.timeline.len(), 1);
        let mut snapshot = loaded.snapshot;
        assert_eq!(
            load_full_timeline(&data_dir, run_id, &mut snapshot).unwrap(),
            expected.len()
        );
        assert_eq!(snapshot.timeline, expected);

        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn hierarchical_layout_keeps_each_parent_family_together() {
        let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/public/data");
        let snapshot =
            read_snapshot(&data_dir, "deepseek-harness:10:local-demo:8:run-root").unwrap();
        let positions = graph_positions(&snapshot.agents, Rect::new(0, 0, 140, 28));
        let x = |id: &str| positions.get(id).unwrap().x;

        assert!(x("agent-docs") < x("agent-security"));
        assert!(x("agent-security") < x("agent-schema"));
        assert!(x("agent-schema") < x("agent-storage"));
        assert!(x("agent-storage") < x("agent-release-notes"));
        assert!(x("agent-release-notes") < x("agent-motion"));
        assert!(x("agent-motion") < x("agent-accessibility"));
        assert!(x("agent-accessibility") < x("agent-performance"));
        assert!(x("agent-performance") < x("agent-tests"));
        let root = positions.get(&snapshot.root_session_id).unwrap();
        assert_eq!(root.x + root.width / 2, 70);
    }

    #[test]
    fn a_single_agent_is_centered_in_the_topology_canvas() {
        let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/public/data");
        let snapshot =
            read_snapshot(&data_dir, "deepseek-harness:10:local-demo:8:run-root").unwrap();
        let area = Rect::new(10, 4, 100, 30);
        let positions = graph_positions(&snapshot.agents[..1], area);
        let node = positions.values().next().unwrap();

        assert_eq!(node.x + node.width / 2, area.x + area.width / 2);
        assert!((node.y + node.height / 2).abs_diff(area.y + area.height / 2) <= 1);
    }

    #[test]
    fn existing_busy_session_does_not_steal_follow_focus() {
        let previous = RunCatalog {
            schema_version: 1,
            pending_event_count: 0,
            runs: vec![
                summary("codex", "2026-08-31T01:00:00Z", 10),
                summary("pi", "2026-08-31T02:00:00Z", 20),
            ],
        };
        let mut refreshed = previous.clone();
        refreshed.runs[0].last_activity_at = Some("2026-08-31T03:00:00Z".into());
        refreshed.runs[0].event_count = 30;

        assert_eq!(
            preferred_reload_run_index(&previous, "pi", &refreshed, true, true),
            Some(1)
        );

        refreshed
            .runs
            .push(summary("new-pi", "2026-08-31T04:00:00Z", 1));
        assert_eq!(
            preferred_reload_run_index(&previous, "pi", &refreshed, true, true),
            Some(2)
        );
    }

    #[test]
    fn arrow_navigation_crosses_a_single_agent_session_boundary() {
        let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/public/data");
        let first_run = "deepseek-harness:10:local-demo:9:run-smoke";
        let mut app = App::load(
            data_dir,
            Some(first_run.into()),
            Duration::from_secs(1),
            "TEST".into(),
        )
        .unwrap();

        assert_eq!(app.snapshot.agents.len(), 1);
        app.select_delta(1).unwrap();
        assert_ne!(app.summary().run_id, first_run);
        assert!(!app.auto_run);
    }

    #[test]
    fn mouse_wheel_navigation_never_crosses_a_session_boundary() {
        let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/public/data");
        let first_run = "deepseek-harness:10:local-demo:9:run-smoke";
        let mut app = App::load(
            data_dir,
            Some(first_run.into()),
            Duration::from_secs(1),
            "TEST".into(),
        )
        .unwrap();

        assert_eq!(app.snapshot.agents.len(), 1);
        app.select_agent_delta(1);
        assert_eq!(app.summary().run_id, first_run);
    }

    #[test]
    fn mouse_wheel_scrolls_detail_without_changing_the_selected_agent() {
        let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/public/data");
        let mut app = App::load(
            data_dir,
            Some("deepseek-harness:10:local-demo:8:run-root".into()),
            Duration::from_secs(1),
            "TEST".into(),
        )
        .unwrap();
        app.selected_id = "run-root".into();
        app.detail_open = true;
        let screen = Rect::new(0, 0, 80, 20);
        let (_, graph, _, _) = screen_regions(screen, app.snapshot.agents.len()).unwrap();
        let detail = detail_area(graph);
        assert!(detail_scroll_limit(graph, &app) > 0);

        app.on_mouse(
            MouseEvent {
                kind: MouseEventKind::ScrollDown,
                column: detail.x + 1,
                row: detail.y + 1,
                modifiers: KeyModifiers::NONE,
            },
            screen,
        )
        .unwrap();

        assert_eq!(app.selected_id, "run-root");
        assert_eq!(app.detail_scroll, 2);
    }

    #[test]
    fn session_management_requires_explicit_dialog_confirmation() {
        let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/public/data");
        let mut app = App::load(
            data_dir,
            Some("deepseek-harness:10:local-demo:9:run-smoke".into()),
            Duration::from_secs(1),
            "TEST".into(),
        )
        .unwrap();

        assert_eq!(
            app.on_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE))
                .unwrap(),
            None
        );
        assert!(matches!(
            app.session_dialog,
            Some(SessionDialog::DeleteConfirm)
        ));
        assert_eq!(
            app.on_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE))
                .unwrap(),
            None
        );
        assert!(app.session_dialog.is_none());

        app.on_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE))
            .unwrap();
        assert_eq!(
            app.on_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE))
                .unwrap(),
            Some(SessionAction::Delete)
        );
    }
}
