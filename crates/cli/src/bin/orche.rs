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
use orchetrace_core::{AgentSnapshot, RunSnapshot, TimelineEntry, ToolSnapshot};
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
    let _observers = observers;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    terminal.clear()?;

    while !app.quit {
        terminal.draw(|frame| draw(frame, &app))?;
        let wait = Duration::from_millis(45);
        if event::poll(wait)? {
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => app.on_key(key)?,
                Event::Mouse(mouse) => {
                    let size = terminal.size()?;
                    app.on_mouse(mouse, Rect::new(0, 0, size.width, size.height));
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
         Usage: orche [--data-dir PATH] [--run RUN_ID] [--refresh-ms 500] [--replay]\n\n\
         By default, orche starts the local ingest service and passively observes\n\
         current Claude, Pi, and DeepSeek Harness sessions. --replay disables it.\n\n\
         Keys:\n\
           q              quit\n\
           ↑/↓ or j/k     select Agent\n\
           Enter/click    open/close Agent detail\n\
           ←/→ or h/l     scrub real timeline\n\
           Home/End       first/latest state\n\
           Space          play/pause at 1× real time\n\
           [ / ]          previous/next run\n\
           f              follow latest live state\n\
           r              reload snapshot\n\
           ?              help overlay"
    );
}

struct App {
    data_dir: PathBuf,
    catalog: RunCatalog,
    run_index: usize,
    snapshot: RunSnapshot,
    selected_id: String,
    cursor_ms: i64,
    playing: bool,
    follow_latest: bool,
    detail_open: bool,
    help_open: bool,
    quit: bool,
    refresh: Duration,
    last_refresh: Instant,
    last_tick: Instant,
    notice: String,
    observer_status: String,
    auto_run: bool,
}

impl App {
    fn load(
        data_dir: PathBuf,
        requested_run: Option<String>,
        refresh: Duration,
        observer_status: String,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let catalog = read_catalog(&data_dir)?;
        if catalog.runs.is_empty() {
            return Err(format!("{} contains no runs", data_dir.display()).into());
        }
        let auto_run = requested_run.is_none();
        let run_index = requested_run
            .as_deref()
            .and_then(|id| catalog.runs.iter().position(|run| run.run_id == id))
            .or_else(|| most_recent_run_index(&catalog))
            .unwrap_or(0);
        let snapshot = read_snapshot(&data_dir, &catalog.runs[run_index].run_id)?;
        let (_, end) = snapshot_bounds(&snapshot);
        let selected_id = snapshot.root_session_id.clone();
        Ok(Self {
            data_dir,
            catalog,
            run_index,
            snapshot,
            selected_id,
            cursor_ms: end,
            playing: false,
            follow_latest: true,
            detail_open: false,
            help_open: false,
            quit: false,
            refresh,
            last_refresh: Instant::now(),
            last_tick: Instant::now(),
            notice: "LIVE FOLLOW".into(),
            observer_status,
            auto_run,
        })
    }

    fn summary(&self) -> &RunSummary {
        &self.catalog.runs[self.run_index]
    }

    fn visible_agents(&self) -> Vec<AgentSnapshot> {
        snapshot_at(&self.snapshot, self.cursor_ms)
    }

    fn on_key(&mut self, key: KeyEvent) -> Result<(), Box<dyn std::error::Error>> {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.quit = true;
            return Ok(());
        }
        if self.help_open {
            self.help_open = false;
            return Ok(());
        }
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Esc if self.detail_open => self.detail_open = false,
            KeyCode::Esc => self.quit = true,
            KeyCode::Char('?') => self.help_open = true,
            KeyCode::Enter => self.detail_open = !self.detail_open,
            KeyCode::Up | KeyCode::Char('k') => self.select_delta(-1),
            KeyCode::Down | KeyCode::Char('j') => self.select_delta(1),
            KeyCode::Left | KeyCode::Char('h') => self.scrub(-1),
            KeyCode::Right | KeyCode::Char('l') => self.scrub(1),
            KeyCode::Home => self.jump(false),
            KeyCode::End => self.jump(true),
            KeyCode::Char(' ') => self.toggle_play(),
            KeyCode::Char('f') => {
                self.follow_latest = !self.follow_latest;
                if self.follow_latest {
                    self.auto_run = true;
                    self.jump(true);
                }
                self.notice = if self.follow_latest {
                    "LIVE FOLLOW".into()
                } else {
                    "HISTORY PINNED".into()
                };
            }
            KeyCode::Char('r') => self.reload(true)?,
            KeyCode::Char('[') => self.change_run(-1)?,
            KeyCode::Char(']') => self.change_run(1)?,
            _ => {}
        }
        Ok(())
    }

    fn on_mouse(&mut self, mouse: MouseEvent, area: Rect) {
        match mouse.kind {
            MouseEventKind::ScrollUp => {
                self.select_delta(-1);
                return;
            }
            MouseEventKind::ScrollDown => {
                self.select_delta(1);
                return;
            }
            MouseEventKind::Down(MouseButton::Left) => {}
            _ => return,
        }
        if self.help_open {
            self.help_open = false;
            return;
        }
        let Some((_, graph, timeline, _)) = screen_regions(area, self.snapshot.agents.len()) else {
            return;
        };
        let agents = self.visible_agents();
        let inner = graph.inner(ratatui::layout::Margin {
            horizontal: 1,
            vertical: 1,
        });
        let positions = graph_positions(&agents, inner);
        if let Some(agent) = agents.iter().find(|agent| {
            positions
                .get(&agent.id)
                .is_some_and(|rect| contains(*rect, mouse.column, mouse.row))
        }) {
            self.selected_id.clone_from(&agent.id);
            self.detail_open = true;
            return;
        }
        if contains(timeline, mouse.column, mouse.row) {
            self.seek_timeline(mouse.column, mouse.row, timeline);
            return;
        }
        if self.detail_open && contains(graph, mouse.column, mouse.row) {
            self.detail_open = false;
        }
    }

    fn tick(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let now = Instant::now();
        if self.playing {
            let elapsed = now.duration_since(self.last_tick).as_millis() as i64;
            let (_, end) = snapshot_bounds(&self.snapshot);
            self.cursor_ms = (self.cursor_ms + elapsed).min(end);
            if self.cursor_ms >= end {
                self.playing = false;
                self.follow_latest = true;
                self.notice = "LIVE FOLLOW".into();
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
        let current_id = self.summary().run_id.clone();
        let next_index = if self.auto_run && self.follow_latest {
            most_recent_run_index(&catalog)
        } else {
            catalog.runs.iter().position(|run| run.run_id == current_id)
        }
        .unwrap_or(0);
        let run_changed = catalog.runs[next_index].run_id != current_id;
        self.run_index = next_index;
        let summary = &catalog.runs[self.run_index];
        let changed = run_changed
            || summary.event_count != self.snapshot.event_count
            || summary.last_activity_at != self.snapshot.last_activity_at;
        self.catalog = catalog;
        if changed || manual {
            self.snapshot = read_snapshot(&self.data_dir, &self.summary().run_id)?;
            if run_changed {
                self.selected_id.clone_from(&self.snapshot.root_session_id);
                self.detail_open = false;
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
        let count = self.catalog.runs.len() as isize;
        self.run_index = (self.run_index as isize + delta).rem_euclid(count) as usize;
        self.snapshot = read_snapshot(&self.data_dir, &self.summary().run_id)?;
        self.cursor_ms = snapshot_bounds(&self.snapshot).1;
        self.selected_id.clone_from(&self.snapshot.root_session_id);
        self.playing = false;
        self.follow_latest = true;
        self.detail_open = false;
        self.auto_run = false;
        self.notice = format!("RUN {}/{}", self.run_index + 1, self.catalog.runs.len());
        Ok(())
    }

    fn select_delta(&mut self, delta: isize) {
        let agents = self.visible_agents();
        if agents.is_empty() {
            return;
        }
        let current = agents
            .iter()
            .position(|agent| agent.id == self.selected_id)
            .unwrap_or(0) as isize;
        let index = (current + delta).rem_euclid(agents.len() as isize) as usize;
        self.selected_id.clone_from(&agents[index].id);
    }

    fn scrub(&mut self, direction: i64) {
        let (start, end) = snapshot_bounds(&self.snapshot);
        let step = ((end - start) / 50).max(100);
        self.cursor_ms = (self.cursor_ms + direction * step).clamp(start, end);
        self.playing = false;
        self.follow_latest = self.cursor_ms == end;
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
        if end {
            self.auto_run = true;
        }
        self.ensure_selection_visible();
    }

    fn toggle_play(&mut self) {
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
        self.last_tick = Instant::now();
        self.notice = "PLAY 1×".into();
        self.ensure_selection_visible();
    }

    fn ensure_selection_visible(&mut self) {
        let agents = self.visible_agents();
        if !agents.iter().any(|agent| agent.id == self.selected_id)
            && let Some(agent) = agents.first()
        {
            self.selected_id.clone_from(&agent.id);
            self.detail_open = false;
        }
    }

    fn seek_timeline(&mut self, column: u16, row: u16, area: Rect) {
        let block = Block::default().borders(Borders::TOP);
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
            self.auto_run = self.follow_latest;
            self.notice = if self.follow_latest {
                "LATEST STATE".into()
            } else {
                "HISTORY PINNED".into()
            };
            self.ensure_selection_visible();
        }
        if row >= inner.y && row < inner.bottom() {
            let max_lanes = inner.height as usize;
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
                .get(offset + row.saturating_sub(inner.y) as usize)
            {
                self.selected_id.clone_from(&agent.id);
            }
        }
    }
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

fn read_snapshot(data_dir: &Path, run_id: &str) -> Result<RunSnapshot, Box<dyn std::error::Error>> {
    let file = format!("run-{}.json", encode_file_component(run_id));
    let path = data_dir.join("runs").join(file);
    let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(serde_json::from_slice(&bytes)?)
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

fn snapshot_at(snapshot: &RunSnapshot, cursor: i64) -> Vec<AgentSnapshot> {
    snapshot
        .agents
        .iter()
        .filter(|agent| {
            agent.id == snapshot.root_session_id
                || parse_ms(agent.started_at.as_deref()).is_none_or(|time| time <= cursor)
        })
        .map(|agent| agent_at(agent, &snapshot.timeline, cursor))
        .collect()
}

fn agent_at(agent: &AgentSnapshot, timeline: &[TimelineEntry], cursor: i64) -> AgentSnapshot {
    let mut view = agent.clone();
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
}

fn screen_regions(area: Rect, agent_count: usize) -> Option<(Rect, Rect, Rect, Rect)> {
    if area.width < 64 || area.height < 20 {
        return None;
    }
    let timeline_height = (agent_count as u16 + 4).clamp(7, (area.height / 3).max(7));
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
                "  {}  {} agents · {} events",
                runtime_label(summary),
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
    frame.render_widget(
        Block::default()
            .borders(Borders::BOTTOM)
            .title(format!(
                " topology · {} ",
                if app.playing { "PLAY 1×" } else { &app.notice }
            ))
            .title_style(Style::default().fg(MUTED))
            .style(Style::default().bg(Color::Rgb(14, 15, 14))),
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
    let positions = graph_positions(&agents, inner);
    draw_edges(frame.buffer_mut(), &agents, &positions);
    for agent in &agents {
        let Some(rect) = positions.get(&agent.id).copied() else {
            continue;
        };
        let selected = agent.id == app.selected_id;
        let state = agent_state(agent);
        let color = state_color(state);
        let title = truncate(&agent.label, rect.width.saturating_sub(4) as usize);
        let provider = agent
            .model
            .as_deref()
            .or(agent.provider.as_deref())
            .unwrap_or("unknown");
        let tool = agent.current_tool.as_deref().unwrap_or("—");
        let lines = vec![
            Line::from(vec![
                Span::styled(state_glyph(state), Style::default().fg(color)),
                Span::styled(format!(" {title}"), Style::default().fg(TEXT).bold()),
            ]),
            Line::from(Span::styled(
                format!("{} · {provider}", agent.role.as_deref().unwrap_or("agent")),
                Style::default().fg(MUTED),
            )),
            Line::from(vec![
                Span::styled(format!("{state:<8}"), Style::default().fg(color)),
                Span::styled(
                    format!(" {}× {tool}", agent.tool_count),
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
        } else {
            Color::Rgb(72, 74, 68)
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
    let width = (graph.width / 5).clamp(18, 28);
    let height = (graph.height / 3).clamp(6, 9);
    let area = Rect::new(graph.right().saturating_sub(width), graph.y, width, height);
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" map ")
        .title_style(Style::default().fg(MUTED))
        .border_style(Style::default().fg(Color::Rgb(58, 60, 55)))
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
            put(frame.buffer_mut(), x, y1, '·', Style::default().fg(GREEN));
        }
        for y in y1.min(y2)..=y1.max(y2) {
            put(frame.buffer_mut(), x2, y, '·', Style::default().fg(GREEN));
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
    let depth_count = levels.keys().max().copied().unwrap_or(0) + 1;
    let card_height = 5_u16.min((area.height / depth_count as u16).max(3));
    let row_step = ((area.height.saturating_sub(card_height)) / depth_count.max(1) as u16).max(4);
    let mut positions = BTreeMap::new();
    for (depth, level) in levels {
        let count = level.len() as u16;
        let slot = (area.width / count.max(1)).max(1);
        let card_width = slot.saturating_sub(2).clamp(12, 24).min(area.width);
        for (index, agent) in level.into_iter().enumerate() {
            let center = area.x + slot * index as u16 + slot / 2;
            let x = center.saturating_sub(card_width / 2).max(area.x);
            let y = area.y + (depth as u16 * row_step).min(area.height.saturating_sub(card_height));
            positions.insert(agent.id.clone(), Rect::new(x, y, card_width, card_height));
        }
    }
    positions
}

fn draw_edges(buffer: &mut Buffer, agents: &[AgentSnapshot], positions: &BTreeMap<String, Rect>) {
    for agent in agents {
        let Some(parent_id) = &agent.parent_id else {
            continue;
        };
        let (Some(parent), Some(child)) = (positions.get(parent_id), positions.get(&agent.id))
        else {
            continue;
        };
        let x1 = parent.x + parent.width / 2;
        let y1 = parent.y + parent.height;
        let x2 = child.x + child.width / 2;
        let y2 = child.y.saturating_sub(1);
        let middle = y1 + y2.saturating_sub(y1) / 2;
        for y in y1..=middle {
            put(buffer, x1, y, '│', Style::default().fg(GREEN));
        }
        for x in x1.min(x2)..=x1.max(x2) {
            put(buffer, x, middle, '─', Style::default().fg(GREEN));
        }
        for y in middle..=y2 {
            put(buffer, x2, y, '│', Style::default().fg(GREEN));
        }
        put(buffer, x2, y2, '▼', Style::default().fg(GREEN));
    }
}

fn put(buffer: &mut Buffer, x: u16, y: u16, symbol: char, style: Style) {
    if let Some(cell) = buffer.cell_mut(Position::new(x, y)) {
        cell.set_char(symbol).set_style(style);
    }
}

fn draw_timeline(frame: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .borders(Borders::TOP)
        .title(format!(
            " timeline · {} / {} ",
            format_elapsed(snapshot_bounds(&app.snapshot).0, app.cursor_ms),
            format_elapsed(
                snapshot_bounds(&app.snapshot).0,
                snapshot_bounds(&app.snapshot).1
            )
        ))
        .title_style(Style::default().fg(ACCENT));
    let inner = block.inner(area);
    frame.render_widget(block.style(Style::default().bg(PANEL)), area);
    if inner.height == 0 {
        return;
    }
    let (start, end) = snapshot_bounds(&app.snapshot);
    let label_width = 14_u16.min(inner.width / 3);
    let track_x = inner.x + label_width;
    let track_width = inner.width.saturating_sub(label_width + 1).max(1);
    let max_lanes = inner.height as usize;
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
        let y = inner.y + row as u16;
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
            Paragraph::new(truncate(
                &agent.label,
                label_width.saturating_sub(1) as usize,
            ))
            .style(label_style),
            Rect::new(inner.x, y, label_width.saturating_sub(1), 1),
        );
        for x in track_x..track_x + track_width {
            put(
                frame.buffer_mut(),
                x,
                y,
                '·',
                Style::default().fg(Color::Rgb(45, 47, 42)),
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
                '─',
            );
        }
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
            put(
                frame.buffer_mut(),
                x,
                y,
                event_glyph(&item.kind),
                Style::default().fg(color),
            );
        }
        let cursor_x = track_x + time_x(app.cursor_ms, start, end, track_width);
        put(
            frame.buffer_mut(),
            cursor_x,
            y,
            '│',
            Style::default().fg(ACCENT).bold(),
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
        let color = if at <= cursor {
            ACCENT
        } else {
            Color::Rgb(82, 83, 77)
        };
        put(buffer, x, y, symbol, Style::default().fg(color));
    }
}

fn time_x(value: i64, start: i64, end: i64, width: u16) -> u16 {
    let span = (end - start).max(1);
    (((value - start).clamp(0, span) as f64 / span as f64) * width.saturating_sub(1) as f64).round()
        as u16
}

fn draw_footer(frame: &mut Frame, area: Rect, app: &App) {
    let mode = if app.playing {
        "Ⅱ pause"
    } else if app.follow_latest {
        "● live"
    } else {
        "▶ play"
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
                    "{} · click/Enter detail · ←→ time · Space play · [ ] run · f live · q quit",
                    app.observer_status
                ),
                area.width.saturating_sub(28) as usize,
            ),
            Style::default().fg(MUTED),
        ),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

fn draw_detail(frame: &mut Frame, graph: Rect, app: &App) {
    let agents = app.visible_agents();
    let Some(agent) = agents.iter().find(|agent| agent.id == app.selected_id) else {
        return;
    };
    let width = (graph.width / 2).clamp(38, 70).min(graph.width);
    let area = Rect::new(
        graph.right().saturating_sub(width),
        graph.y,
        width,
        graph.height,
    );
    frame.render_widget(Clear, area);
    let events = app
        .snapshot
        .timeline
        .iter()
        .filter(|item| {
            item.session_id == agent.id
                && parse_ms(Some(&item.at)).is_some_and(|time| time <= app.cursor_ms)
        })
        .collect::<Vec<_>>();
    let mut lines = vec![
        Line::from(vec![
            Span::styled(
                agent_state(agent),
                Style::default().fg(state_color(agent_state(agent))).bold(),
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
            .as_deref()
            .unwrap_or("No terminal outcome was recorded at this time."),
        Style::default().fg(Color::Gray),
    )));
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT))
                    .title(format!(" {} · esc × ", agent.label))
                    .style(Style::default().bg(PANEL)),
            ),
        area,
    );
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
    let height = 16.min(area.height.saturating_sub(2));
    let popup = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Paragraph::new(
            "Click select Agent and open detail\nClick timeline to seek real time\n↑/↓  select Agent\nEnter open/close detail\n←/→  move real-time cursor\nHome/End first/latest state\nSpace play/pause at 1×\n[ / ] previous/next run\nf     follow newest live run\nr     reload from disk\nq     quit\n\nPress any key to close",
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

fn runtime_label(summary: &RunSummary) -> &'static str {
    match summary.runtime {
        orchetrace_protocol::RuntimeKind::ClaudeCode => "CLAUDE",
        orchetrace_protocol::RuntimeKind::Pi => "PI",
        orchetrace_protocol::RuntimeKind::DeepSeekHarness => "HARNESS",
    }
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
        "prompt" | "reasoning" | "message" => '↳',
        "tool" => '⚒',
        "tool-result" | "outcome" => '✓',
        "error" => '×',
        "spawn" => '◆',
        _ => '·',
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
    } else {
        format!("{}m {:02}s", millis / 60_000, (millis % 60_000) / 1_000)
    }
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
    fn run_ids_use_the_same_utf8_hex_file_names_as_ingest() {
        assert_eq!(encode_file_component("pi:会话"), "70693ae4bc9ae8af9d");
    }

    #[test]
    fn time_axis_maps_both_bounds() {
        assert_eq!(time_x(1_000, 1_000, 2_000, 101), 0);
        assert_eq!(time_x(2_000, 1_000, 2_000, 101), 100);
    }
}
