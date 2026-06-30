/* ---------------------------------------------------------------------------
   OpenMontage Client-Side Application Logic
   --------------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
    initApp();
});

// State Management
const STATE = {
    activeTab: "dashboard",
    pipelines: [],
    projects: [],
    demos: [],
    activeProject: null,
    activeDemo: null,
    renderSocket: null,
    expandedScriptSectionId: null,
    expandedSceneId: null
};

const CANONICAL_STAGE_ARTIFACTS = {
    idea: "brief",
    research: "research_brief",
    proposal: "proposal_packet",
    script: "script",
    scene_plan: "scene_plan",
    assets: "asset_manifest",
    edit: "edit_decisions",
    compose: "render_report",
    publish: "publish_log"
};

// Initialization
function initApp() {
    setupTabNavigation();
    loadSystemStatus();
    loadPipelines();
    loadDemos();
    loadRegistry();
    loadSettings();
    
    // Auto-refresh system status every 15 seconds
    setInterval(loadSystemStatus, 15000);
}

// ---------------------------------------------------------------------------
// Tab & View Switching Navigation
// ---------------------------------------------------------------------------
function setupTabNavigation() {
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach(item => {
        item.addEventListener("click", () => {
            const tabName = item.getAttribute("data-tab");
            switchTab(tabName);
        });
    });
}

function switchTab(tabName) {
    // Update nav buttons
    document.querySelectorAll(".nav-item").forEach(btn => {
        if (btn.getAttribute("data-tab") === tabName) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
    
    // Update view panes
    document.querySelectorAll(".view-pane").forEach(pane => {
        pane.classList.remove("active");
        if (pane.id === `view-${tabName}`) {
            pane.classList.add("active");
        }
    });
    
    // Update header title
    const formattedTitle = tabName.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    document.getElementById("page-title").textContent = formattedTitle;
    
    STATE.activeTab = tabName;
    
    // Trigger tab-specific loaders
    if (tabName === "dashboard") {
        loadSystemStatus();
        loadRegistry();
    } else if (tabName === "projects") {
        loadProjects();
    } else if (tabName === "demo-runner") {
        loadDemos();
    } else if (tabName === "capabilities") {
        loadRegistry();
    } else if (tabName === "settings") {
        loadSettings();
    }
}

// ---------------------------------------------------------------------------
// API Loaders & Rendering Helper Functions
// ---------------------------------------------------------------------------

async function loadSystemStatus() {
    try {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error("Status API failure");
        const data = await res.json();
        
        // Populate Runtimes Badges
        updateRuntimeBadge("status-node", data.runtimes.node);
        updateRuntimeBadge("status-ffmpeg", data.runtimes.ffmpeg);
        updateRuntimeBadge("status-gpu", data.runtimes.python); // Python is active if this script runs
        
        // Update Remotion & HF health statuses
        document.getElementById("health-remotion").className = `status-pill ${data.runtimes.remotion ? 'green' : 'red'}`;
        document.getElementById("health-remotion").textContent = data.runtimes.remotion ? "Active" : "Unavailable";
        
        document.getElementById("health-hf").className = `status-pill ${data.runtimes.hyperframes ? 'green' : 'red'}`;
        document.getElementById("health-hf").textContent = data.runtimes.hyperframes ? "Ready" : "Unavailable";
        
        // Budget calculation
        const limit = data.budget.limit;
        const spent = data.budget.spent;
        const pct = Math.min((spent / limit) * 100, 100);
        
        document.getElementById("budget-progress-text").textContent = `$${spent.toFixed(2)} / $${limit.toFixed(2)}`;
        document.getElementById("budget-progress-bar").style.width = `${pct}%`;
        
        document.getElementById("cost-limit").textContent = `$${limit.toFixed(2)}`;
        document.getElementById("cost-mode").textContent = data.budget.mode.toUpperCase();
        
    } catch (e) {
        console.error("Error loading system status:", e);
    }
}

function updateRuntimeBadge(id, isAvailable) {
    const el = document.getElementById(id);
    if (!el) return;
    if (isAvailable) {
        el.classList.add("online");
        el.classList.remove("offline");
    } else {
        el.classList.add("offline");
        el.classList.remove("online");
    }
}

async function loadPipelines() {
    try {
        const res = await fetch("/api/pipelines");
        if (!res.ok) throw new Error("Pipelines list API failure");
        STATE.pipelines = await res.json();
        
        // Populate pipeline selections in project builder form
        const selectEl = document.getElementById("p-pipeline");
        selectEl.innerHTML = "";
        
        STATE.pipelines.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.name;
            opt.textContent = `${p.title} (${p.description})`;
            selectEl.appendChild(opt);
        });
        
        // Update dashboard load counter
        document.getElementById("health-pipelines-count").textContent = `${STATE.pipelines.length} Loaded`;
    } catch (e) {
        console.error("Error loading pipelines:", e);
    }
}

// ---------------------------------------------------------------------------
// Projects Logic (List, Create, and Inspection Details)
// ---------------------------------------------------------------------------

async function loadProjects() {
    try {
        const res = await fetch("/api/projects");
        if (!res.ok) throw new Error("Projects list API failure");
        STATE.projects = await res.json();
        renderProjectsList();
    } catch (e) {
        console.error("Error loading projects:", e);
    }
}

function renderProjectsList() {
    const grid = document.getElementById("projects-grid");
    grid.innerHTML = "";
    
    if (STATE.projects.length === 0) {
        grid.innerHTML = `
            <div class="empty-state full-width" style="grid-column: span 3;">
                <h5>No Projects Found</h5>
                <p>Click "New Project" above to initialize your first video workspace.</p>
            </div>
        `;
        return;
    }
    
    STATE.projects.forEach(p => {
        const card = document.createElement("div");
        card.className = "card project-card animate-fade-in";
        
        // Determine status classes
        let statusClass = "purple";
        if (p.status === "completed") statusClass = "green";
        if (p.status === "failed") statusClass = "red";
        if (p.status === "awaiting_human") statusClass = "orange";
        
        // Human readable date
        let updatedDate = "Never";
        if (p.last_updated) {
            const date = new Date(p.last_updated);
            updatedDate = date.toLocaleDateString() + " " + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        }
        
        const allStages = ["idea", "script", "scene_plan", "assets", "edit", "compose", "publish"];
        const completedStagesCount = p.completed_stages.length;
        const totalStages = allStages.length;
        const percentStages = (completedStagesCount / totalStages) * 100;
        
        card.innerHTML = `
            <div class="card-header-flex">
                <h4>${p.project_id.replace(/-/g, " ").replace(/(^\w|\s\w)/g, m => m.toUpperCase())}</h4>
                <span class="status-pill ${statusClass}">${p.status}</span>
            </div>
            <div class="project-meta">
                <span>Pipeline: <strong>${p.pipeline_type}</strong></span>
                <span>Updated: <strong>${updatedDate}</strong></span>
            </div>
            <div class="project-steps">
                <div class="step-summary">
                    <span>Workflow Progress</span>
                    <span>${completedStagesCount}/${totalStages} Stages</span>
                </div>
                <div class="step-dots">
                    ${allStages.map((stg, i) => {
                        let cls = "step-dot";
                        if (p.completed_stages.includes(stg)) {
                            cls += " completed";
                        } else if (p.next_stage === stg) {
                            cls += " active";
                        }
                        return `<div class="${cls}" title="${stg}"></div>`;
                    }).join("")}
                </div>
            </div>
        `;
        
        card.addEventListener("click", () => {
            viewProjectDetails(p.project_id);
        });
        grid.appendChild(card);
    });
}

function showCreateProjectForm() {
    document.getElementById("projects-list-container").style.display = "none";
    document.getElementById("projects-create-container").style.display = "block";
}

function hideCreateProjectForm() {
    document.getElementById("projects-list-container").style.display = "block";
    document.getElementById("projects-create-container").style.display = "none";
}

function showCreateProjectView() {
    switchTab("projects");
    showCreateProjectForm();
}

// Project Creator Form Submission
document.getElementById("create-project-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const project_id = document.getElementById("p-id").value;
    const title = document.getElementById("p-title").value;
    const pipeline_type = document.getElementById("p-pipeline").value;
    const style_playbook = document.getElementById("p-playbook").value;
    const target_platform = document.getElementById("p-platform").value;
    const duration = parseInt(document.getElementById("p-duration").value);
    const prompt = document.getElementById("p-prompt").value;
    
    try {
        const res = await fetch("/api/projects", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                project_id, title, pipeline_type, style_playbook, target_platform, duration, prompt
            })
        });
        
        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.detail || "Failed to create project");
        }
        
        const result = await res.json();
        // Clear form
        document.getElementById("create-project-form").reset();
        hideCreateProjectForm();
        loadProjects();
    } catch (err) {
        alert("Error creating project: " + err.message);
    }
});

// Project Detail Inspection View
async function viewProjectDetails(projectId) {
    document.getElementById("projects-list-container").style.display = "none";
    document.getElementById("projects-create-container").style.display = "none";
    document.getElementById("projects-detail-container").style.display = "block";
    
    try {
        const res = await fetch(`/api/projects/${projectId}`);
        if (!res.ok) throw new Error("Project detail API failure");
        const details = await res.json();
        STATE.activeProject = details;
        
        renderProjectDetailsView();
    } catch (e) {
        console.error("Error viewing project detail:", e);
        alert("Could not load project workspace details.");
    }
}

function hideProjectDetails() {
    document.getElementById("projects-list-container").style.display = "block";
    document.getElementById("projects-detail-container").style.display = "none";
    
    // Stop video player
    const player = document.getElementById("detail-video-player");
    player.pause();
    player.src = "";
    
    STATE.activeProject = null;
}

function renderProjectDetailsView() {
    const dp = STATE.activeProject;
    
    // Set headers
    const pTitle = dp.project_id.replace(/-/g, " ").replace(/(^\w|\s\w)/g, m => m.toUpperCase());
    document.getElementById("detail-project-title").textContent = pTitle;
    
    // Latest status pill
    let latestStage = "idea";
    let latestStatus = "new";
    let latestType = "unknown";
    
    const checkpointStages = ["idea", "script", "scene_plan", "assets", "edit", "compose", "publish"];
    
    // Find the latest active checkpoint
    checkpointStages.forEach(stg => {
        if (dp.checkpoints[stg]) {
            latestStage = stg;
            latestStatus = dp.checkpoints[stg].status;
            latestType = dp.checkpoints[stg].pipeline_type || latestType;
        }
    });
    
    const stgBadge = document.getElementById("detail-project-status");
    stgBadge.textContent = `${latestStage}: ${latestStatus}`;
    stgBadge.className = `status-pill ${latestStatus === 'completed' ? 'green' : latestStatus === 'failed' ? 'red' : 'orange'}`;
    
    document.getElementById("detail-project-meta").textContent = `Pipeline Type: ${latestType}`;
    
    // Stepper Timeline rendering
    const stepper = document.getElementById("project-stepper");
    stepper.innerHTML = "";
    
    checkpointStages.forEach(stg => {
        const cp = dp.checkpoints[stg];
        const stepItem = document.createElement("div");
        stepItem.className = "stepper-item";
        
        let status = "pending";
        let detail = "Awaiting execution";
        let timeText = "";
        
        if (cp) {
            status = cp.status;
            if (status === "completed") {
                detail = `Canonical artifact '${CANONICAL_STAGE_ARTIFACTS[stg]}' generated.`;
            } else if (status === "awaiting_human") {
                detail = "Paused: awaiting user review/approval.";
            } else if (status === "in_progress") {
                detail = "Orchestrating stage...";
            } else if (status === "failed") {
                detail = cp.error || "Execution failed";
            }
            if (cp.timestamp) {
                const date = new Date(cp.timestamp);
                timeText = date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) + " " + date.toLocaleDateString();
            }
        }
        
        stepItem.classList.add(status);
        stepItem.innerHTML = `
            <div class="stepper-icon"></div>
            <div class="stepper-content">
                <span class="stepper-title">${stg.charAt(0).toUpperCase() + stg.slice(1).replace("_", " ")}</span>
                <span class="stepper-desc">${detail}</span>
                ${timeText ? `<span class="stepper-time">${timeText}</span>` : ""}
            </div>
        `;
        stepper.appendChild(stepItem);
    });
    
    // Render media previews if available
    const videoCard = document.getElementById("detail-video-card");
    const videoPlayer = document.getElementById("detail-video-player");
    
    // Look for mp4 files in files list
    const finalRenderFile = dp.files.find(f => f.rel_path === "renders/final.mp4" || f.rel_path.includes("final.mp4"));
    if (finalRenderFile) {
        videoCard.style.display = "block";
        videoPlayer.src = `/api/media/project/${dp.project_id}/${finalRenderFile.rel_path}`;
        
        const sizeMb = finalRenderFile.size / (1024 * 1024);
        document.getElementById("detail-video-size").textContent = `File Size: ${sizeMb.toFixed(2)} MB`;
        
        // Find compose render report for duration
        let duration = 60;
        if (dp.checkpoints.compose && dp.checkpoints.compose.artifacts.render_report) {
            const report = dp.checkpoints.compose.artifacts.render_report;
            if (report.outputs && report.outputs[0]) {
                duration = report.outputs[0].duration_seconds || duration;
            }
        }
        document.getElementById("detail-video-duration").textContent = `Duration: ${Math.round(duration)}s`;
    } else {
        videoCard.style.display = "none";
        videoPlayer.src = "";
    }
    
    // Render active artifact tabs
    renderArtifactTabs();
}

function renderArtifactTabs() {
    const dp = STATE.activeProject;
    if (!dp) return;
    
    // Get currently selected tab
    const activeTab = document.querySelector(".artifact-tab-btn.active").getAttribute("data-art-tab");
    
    const scriptPane = document.getElementById("art-tab-script");
    const scenePane = document.getElementById("art-tab-scene_plan");
    const decisionsPane = document.getElementById("art-tab-decisions");
    const assetsPane = document.getElementById("art-tab-files");
    
    // 1. Render Script Tab
    let scriptData = null;
    if (dp.checkpoints.script && dp.checkpoints.script.artifacts.script) {
        scriptData = dp.checkpoints.script.artifacts.script;
    }
    
    if (scriptData && scriptData.sections) {
        scriptPane.innerHTML = `
            <h5>Title: ${scriptData.title || "AI Video"}</h5>
            <p class="text-muted mb-3">Duration: ${scriptData.total_duration_seconds} seconds</p>
            <div class="script-sections-list">
                ${scriptData.sections.map(sec => {
                    const isExpanded = STATE.expandedScriptSectionId === sec.id;
                    return `
                    <div class="script-section-block ${isExpanded ? 'expanded' : ''}" onclick="toggleScriptSection('${sec.id}', event)">
                        <div class="script-section-header">
                            <span>ID: ${sec.id} (${sec.label})</span>
                            <span>${sec.start_seconds}s - ${sec.end_seconds}s</span>
                        </div>
                        ${isExpanded ? `
                            <div class="edit-form mt-2">
                                <div class="form-group mb-2">
                                    <label class="form-label">Narration Text</label>
                                    <textarea class="form-control w-100" id="edit-script-text-${sec.id}" rows="3" onclick="event.stopPropagation()">${sec.text}</textarea>
                                </div>
                                <div class="form-group mb-2">
                                    <label class="form-label">Speaker Directions</label>
                                    <input type="text" class="form-control" id="edit-script-directions-${sec.id}" value="${sec.speaker_directions || ''}" onclick="event.stopPropagation()">
                                </div>
                                <div class="d-flex gap-2 justify-content-end">
                                    <button class="btn btn-secondary btn-sm" onclick="cancelScriptEdit(event)">Cancel</button>
                                    <button class="btn btn-primary btn-sm" onclick="saveScriptEdit('${sec.id}', event)">Save Changes</button>
                                </div>
                            </div>
                        ` : `
                            <p class="script-section-text">${sec.text}</p>
                            ${sec.enhancement_cues && sec.enhancement_cues.length ? `
                                <div class="script-section-cues">
                                    <strong>Visual Cues:</strong> ${sec.enhancement_cues.map(cue => cue.description).join(", ")}
                                </div>
                            ` : ""}
                            <div class="edit-hint text-muted mt-2 text-xs"><i class="fas fa-edit"></i> Click to expand and edit</div>
                        `}
                    </div>
                    `;
                }).join("")}
            </div>
        `;
    } else {
        scriptPane.innerHTML = `<div class="empty-state">No script generated yet. Run the script stage first.</div>`;
    }
    
    // 2. Render Scene Plan Tab
    let scenePlan = null;
    if (dp.checkpoints.scene_plan && dp.checkpoints.scene_plan.artifacts.scene_plan) {
        scenePlan = dp.checkpoints.scene_plan.artifacts.scene_plan;
    }
    
    if (scenePlan && scenePlan.scenes) {
        scenePane.innerHTML = `
            <h5>Style Playbook: <span class="status-pill purple">${scenePlan.style_playbook}</span></h5>
            <div class="scene-plan-list mt-3">
                ${scenePlan.scenes.map(sc => {
                    const isExpanded = STATE.expandedSceneId === sc.id;
                    return `
                    <div class="scene-plan-card ${isExpanded ? 'expanded' : ''}" onclick="toggleSceneSection('${sc.id}', event)">
                        ${isExpanded ? `
                            <div class="scene-info w-100">
                                <div class="scene-info-header border-b pb-2 mb-2 d-flex justify-content-between">
                                    <span class="scene-num">${sc.id}</span>
                                    <span>${sc.start_seconds}s - ${sc.end_seconds}s</span>
                                </div>
                                <div class="edit-form w-100">
                                    <div class="form-group mb-2">
                                        <label class="form-label">Scene Description</label>
                                        <textarea class="form-control w-100" id="edit-scene-desc-${sc.id}" rows="3" onclick="event.stopPropagation()">${sc.description}</textarea>
                                    </div>
                                    <div class="form-group mb-2">
                                        <label class="form-label">Visual Type</label>
                                        <select class="form-control" id="edit-scene-type-${sc.id}" onclick="event.stopPropagation()">
                                            <option value="text_card" ${sc.type === 'text_card' ? 'selected' : ''}>Text Card</option>
                                            <option value="animation" ${sc.type === 'animation' ? 'selected' : ''}>Animation</option>
                                            <option value="video" ${sc.type === 'video' ? 'selected' : ''}>Video</option>
                                            <option value="image" ${sc.type === 'image' ? 'selected' : ''}>Image</option>
                                            <option value="talking_head" ${sc.type === 'talking_head' ? 'selected' : ''}>Talking Head</option>
                                        </select>
                                    </div>
                                    <div class="d-flex gap-2 justify-content-end mt-2">
                                        <button class="btn btn-secondary btn-sm" onclick="cancelSceneEdit(event)">Cancel</button>
                                        <button class="btn btn-primary btn-sm" onclick="saveSceneEdit('${sc.id}', event)">Save Changes</button>
                                    </div>
                                </div>
                            </div>
                        ` : `
                            <div class="scene-info">
                                <span class="scene-num">${sc.id}</span>
                                <span class="scene-type-badge">${sc.type}</span>
                                <p class="scene-desc">${sc.description}</p>
                                ${sc.required_assets && sc.required_assets.length ? `
                                    <div class="scene-assets">
                                        <strong>Required Assets:</strong> ${sc.required_assets.map(a => `${a.type} (${a.source})`).join(", ")}
                                    </div>
                                ` : ""}
                            </div>
                            <div class="scene-time">
                                <span>${sc.start_seconds}s - ${sc.end_seconds}s</span>
                                <div class="edit-hint text-muted mt-2 text-xs"><i class="fas fa-edit"></i> Edit</div>
                            </div>
                        `}
                    </div>
                    `;
                }).join("")}
            </div>
        `;
    } else {
        scenePane.innerHTML = `<div class="empty-state">No scene plan generated yet. Run the scene_plan stage first.</div>`;
    }
    
    // 3. Render Decision Log
    if (dp.decision_log && dp.decision_log.decisions && dp.decision_log.decisions.length) {
        decisionsPane.innerHTML = `
            <div class="decision-timeline">
                ${dp.decision_log.decisions.map(dec => `
                    <div class="decision-block">
                        <div class="decision-header">
                            <span>${dec.category.toUpperCase()}: ${dec.decision_id}</span>
                            <span class="text-muted font-mono">${dec.timestamp ? dec.timestamp.split("T")[0] : ""}</span>
                        </div>
                        <div class="mt-1">Action: <strong>${dec.action_taken || "Executed"}</strong></div>
                        <p class="decision-reason">Rationale: ${dec.rationale}</p>
                    </div>
                `).join("")}
            </div>
        `;
    } else {
        decisionsPane.innerHTML = `<div class="empty-state">No decisions logged. Standard automatic checkpoints applied.</div>`;
    }
    
    // 4. Render Assets Tab
    const assetsBody = document.getElementById("assets-list-body");
    assetsBody.innerHTML = "";
    if (dp.files && dp.files.length) {
        dp.files.forEach(f => {
            const tr = document.createElement("tr");
            const sizeMb = f.size / (1024 * 1024);
            tr.innerHTML = `
                <td class="font-mono">${f.name}</td>
                <td>${f.rel_path}</td>
                <td>${sizeMb.toFixed(3)} MB</td>
                <td>
                    <a href="/api/media/project/${dp.project_id}/${f.rel_path}" target="_blank" class="upgrade-link">View File</a>
                </td>
            `;
            assetsBody.appendChild(tr);
        });
    } else {
        assetsBody.innerHTML = `<tr><td colspan="4" class="text-center empty-state">No asset files generated on disk yet.</td></tr>`;
    }
}

// Artifact Sub-Tab Clicks
document.querySelectorAll(".artifact-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".artifact-tab-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        
        document.querySelectorAll(".artifact-tab-pane").forEach(pane => pane.classList.remove("active"));
        const targetId = `art-tab-${btn.getAttribute("data-art-tab")}`;
        document.getElementById(targetId).classList.add("active");
        
        renderArtifactTabs();
    });
});

// ---------------------------------------------------------------------------
// Remotion Demo Runner View Logic
// ---------------------------------------------------------------------------

async function loadDemos() {
    try {
        const res = await fetch("/api/demos");
        if (!res.ok) throw new Error("Demos fetch API failure");
        STATE.demos = await res.json();
        renderDemosList();
    } catch (e) {
        console.error("Error loading demos:", e);
    }
}

function renderDemosList() {
    const listContainer = document.getElementById("demos-container");
    listContainer.innerHTML = "";
    
    STATE.demos.forEach(demo => {
        const item = document.createElement("div");
        item.className = "demo-item animate-fade-in";
        if (STATE.activeDemo && STATE.activeDemo.name === demo.name) {
            item.classList.add("selected");
        }
        
        item.innerHTML = `
            <h5>${demo.name.replace(/-/g, " ").replace(/(^\w|\s\w)/g, m => m.toUpperCase())}</h5>
            <p>${demo.description}</p>
            <div class="demo-item-footer">
                <span>Props: ${demo.name}.json</span>
                <span class="render-badge">${demo.rendered ? "✓ Rendered" : "Ready"}</span>
            </div>
        `;
        
        item.addEventListener("click", () => {
            selectDemo(demo);
        });
        listContainer.appendChild(item);
    });
}

function selectDemo(demo) {
    STATE.activeDemo = demo;
    
    // Visual select classes
    document.querySelectorAll(".demo-item").forEach(item => {
        item.classList.remove("selected");
    });
    renderDemosList();
    
    const videoCard = document.getElementById("demo-video-card");
    const videoPlayer = document.getElementById("demo-video-player");
    
    // Show/hide render player
    if (demo.rendered) {
        videoCard.style.display = "block";
        videoPlayer.src = `/api/media/demo/${demo.name}`;
    } else {
        videoCard.style.display = "none";
        videoPlayer.src = "";
    }
    
    // Render terminal console with active run offers
    const terminal = document.getElementById("log-terminal");
    terminal.innerHTML = `<div class="terminal-line system">Ready to render ${demo.name}. Click 'Render timline' button to compile.</div>`;
    
    // Add run button to header
    const headerStatus = document.getElementById("render-status");
    headerStatus.innerHTML = `
        <button class="btn btn-primary btn-sm" onclick="runActiveDemo()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            <span>Render timeline</span>
        </button>
    `;
}

function runActiveDemo() {
    if (!STATE.activeDemo) return;
    
    const demo = STATE.activeDemo;
    const terminal = document.getElementById("log-terminal");
    const renderStatusLabel = document.getElementById("render-status");
    
    terminal.innerHTML = "";
    appendTerminalLine(`Connecting to render pipeline server for ${demo.name}...`, "system");
    
    renderStatusLabel.innerHTML = `<span class="status-pill orange animate-pulse-glow">Rendering</span>`;
    
    // Initialize WebSockets connection
    // Calculate WebSocket host relative to location host
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${window.location.host}/ws/render/${demo.name}`;
    
    if (STATE.renderSocket) {
        STATE.renderSocket.close();
    }
    
    const socket = new WebSocket(wsUrl);
    STATE.renderSocket = socket;
    
    socket.onmessage = (event) => {
        const text = event.data;
        
        if (text === "RENDER_COMPLETE") {
            appendTerminalLine("\n✓ Render pipeline completed successfully!", "success");
            renderStatusLabel.innerHTML = `<span class="status-pill green">Completed</span>`;
            
            // Reload and autoplay video
            setTimeout(async () => {
                await loadDemos();
                // Re-find active demo
                const updatedDemo = STATE.demos.find(d => d.name === demo.name);
                if (updatedDemo) {
                    selectDemo(updatedDemo);
                }
            }, 1000);
            
            socket.close();
        } else if (text.startsWith("RENDER_FAILED")) {
            appendTerminalLine(`\n✗ ${text}`, "error");
            renderStatusLabel.innerHTML = `<span class="status-pill red">Failed</span>`;
            socket.close();
        } else {
            // Standard console line
            let cls = "";
            if (text.includes("Error:") || text.includes("FAIL")) cls = "error";
            else if (text.includes("Done:") || text.includes("succeeded")) cls = "success";
            appendTerminalLine(text, cls);
        }
    };
    
    socket.onerror = (err) => {
        appendTerminalLine(`Connection error occurred: ${err.message || "WebSocket Connection Interrupted"}`, "error");
        renderStatusLabel.innerHTML = `<span class="status-pill red">Connection Error</span>`;
    };
    
    socket.onclose = () => {
        STATE.renderSocket = null;
    };
}

function appendTerminalLine(text, className = "") {
    const terminal = document.getElementById("log-terminal");
    const line = document.createElement("div");
    line.className = `terminal-line ${className}`;
    line.textContent = text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
}

// ---------------------------------------------------------------------------
// Capabilities Catalog Tab View Logic
// ---------------------------------------------------------------------------

async function loadRegistry() {
    try {
        const res = await fetch("/api/registry");
        if (!res.ok) throw new Error("Registry API failure");
        const data = await res.json();
        
        renderCapabilitiesCatalog(data);
        renderSetupOffers(data.summary.setup_offers);
    } catch (e) {
        console.error("Error loading registry:", e);
    }
}

function renderCapabilitiesCatalog(data) {
    const catalog = document.getElementById("capabilities-catalog");
    catalog.innerHTML = "";
    
    const summary = data.summary;
    const capabilities = data.capabilities;
    
    for (const [capName, tools] of Object.entries(capabilities)) {
        const capGroup = document.createElement("div");
        capGroup.className = "cap-group animate-fade-in";
        
        // Find configured ratio
        const capSummary = summary.capabilities.find(c => c.capability === capName);
        const configuredCount = capSummary ? capSummary.configured : 0;
        const totalCount = capSummary ? capSummary.total : 0;
        
        capGroup.innerHTML = `
            <div class="cap-group-header">
                <span class="cap-group-title">${capName.replace(/_/g, " ")}</span>
                <span class="status-pill purple">${configuredCount} of ${totalCount} Configured</span>
            </div>
            <div class="tools-list">
                ${tools.map(tool => {
                    const isAvailable = tool.status === "available";
                    return `
                        <div class="tool-card">
                            <div class="tool-card-header">
                                <span class="tool-name">${tool.name}</span>
                                <span class="status-pill ${isAvailable ? 'green' : 'red'}">${tool.status}</span>
                            </div>
                            <p class="tool-desc">${tool.best_for || 'General purpose processing tool.'}</p>
                            <span class="tool-runtime">Runtime: ${tool.runtime.toUpperCase()}</span>
                        </div>
                    `;
                }).join("")}
            </div>
        `;
        catalog.appendChild(capGroup);
    }
}

function renderSetupOffers(offers) {
    const container = document.getElementById("upgrade-cards");
    container.innerHTML = "";
    
    if (!offers || offers.length === 0) {
        container.innerHTML = `<p class="text-muted">All capabilities are fully configured. You have access to every generator!</p>`;
        return;
    }
    
    // Pick first 3 offers to display on dashboard
    offers.slice(0, 3).forEach(offer => {
        const card = document.createElement("div");
        card.className = "upgrade-card animate-fade-in";
        
        // Find key variable names to list
        const keyName = offer.env_vars ? offer.env_vars.join(" / ") : "API Key";
        
        card.innerHTML = `
            <div>
                <div class="upgrade-header">
                    <span class="upgrade-title">${offer.tool.replace(/_/g, " ").toUpperCase()}</span>
                    <span class="status-pill orange">${offer.capability.replace(/_/g, " ")}</span>
                </div>
                <p class="upgrade-desc">${offer.install_instructions || `Configure the required ${keyName} env variable to enable this provider.`}</p>
            </div>
            <div class="upgrade-footer">
                <span class="upgrade-effort">Complexity: 1-minute</span>
                <span class="upgrade-link" onclick="switchTab('settings')">Unlock Now</span>
            </div>
        `;
        container.appendChild(card);
    });
}

// ---------------------------------------------------------------------------
// Settings View Logic (.env Variable Editor)
// ---------------------------------------------------------------------------

async function loadSettings() {
    try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error("Settings fetch API failure");
        const settings = await res.json();
        renderSettingsForm(settings);
    } catch (e) {
        console.error("Error loading settings:", e);
    }
}

function renderSettingsForm(settings) {
    const form = document.getElementById("settings-form");
    form.innerHTML = "";
    
    const descriptions = {
        "FAL_KEY": "Credentials for fal.ai gateway. Unlocks FLUX, Kling, Google Veo, and MiniMax generators.",
        "GOOGLE_API_KEY": "Vertex AI and Google Cloud services. Unlocks Imagen 3 still/video and Cloud TTS.",
        "ELEVENLABS_API_KEY": "ElevenLabs narration voiceover, music generation, and audio sound effects.",
        "OPENAI_API_KEY": "OpenAI platform credentials. Enables DALL-E image generation and TTS voiceovers.",
        "XAI_API_KEY": "xAI Grok credentials. Enables Grok image generation and cinematic video generation.",
        "DOUBAO_SPEECH_API_KEY": "Volcengine console token for high fidelity multilingual Chinese voice narration.",
        "SUNO_API_KEY": "Suno AI platform keys for complete lyric and backing track audio generation.",
        "HEYGEN_API_KEY": "HeyGen dashboard access. Enables avatars, spokespersons, dubbing, and video translations.",
        "RUNWAY_API_KEY": "Runway direct API keys for Gen-3 and Gen-4 cinematic clip generation.",
        "PEXELS_API_KEY": "Pexels developer credentials for auto-searching stock video footage clips.",
        "PIXABAY_API_KEY": "Pixabay developer keys for indexing and download of stock audio/video libraries.",
        "UNSPLASH_ACCESS_KEY": "Unsplash access credentials to index free high-resolution stock photography.",
        "HF_TOKEN": "HuggingFace token. Enables WhisperX speaker diarization (splitting voice segments)."
    };
    
    // Sort keys alphabetically for clean structure
    const sortedKeys = Object.keys(settings).sort();
    
    sortedKeys.forEach(k => {
        const row = document.createElement("div");
        row.className = "settings-row animate-fade-in";
        
        const value = settings[k];
        const isKeyVal = k.includes("KEY") || k.includes("TOKEN") || k.includes("SECRET");
        const desc = descriptions[k] || "Configuration variable for OpenMontage generator adapters.";
        
        row.innerHTML = `
            <div class="settings-info">
                <span class="settings-label font-mono">${k}</span>
                <span class="settings-desc">${desc}</span>
            </div>
            <div class="settings-input-wrapper">
                <input type="${isKeyVal ? 'password' : 'text'}" 
                       id="set-${k}" 
                       value="${value}" 
                       placeholder="${isKeyVal ? '••••••••••••••••••••••••••••••••' : 'Not configured'}">
                ${isKeyVal ? `
                    <button type="button" onclick="toggleInputMask('set-${k}')" title="Toggle Visibility">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="eye-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    </button>
                ` : ""}
            </div>
        `;
        form.appendChild(row);
    });
    
    // Add submit handler to form
    form.onsubmit = async (e) => {
        e.preventDefault();
        
        const updatedSettings = {};
        sortedKeys.forEach(k => {
            const input = document.getElementById(`set-${k}`);
            if (input) {
                updatedSettings[k] = input.value;
            }
        });
        
        try {
            const saveRes = await fetch("/api/settings", {
                value: "POST",
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(updatedSettings)
            });
            
            if (!saveRes.ok) throw new Error("Save settings failure");
            
            alert("Settings updated successfully! Engine parameters re-cached.");
            loadSettings();
            loadSystemStatus();
        } catch (err) {
            alert("Error saving settings: " + err.message);
        }
    };
}

function toggleInputMask(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === "password") {
        el.type = "text";
    } else {
        el.type = "password";
    }
}

// Expand / Edit Handlers
function toggleScriptSection(secId, event) {
    if (event.target.closest('.edit-form')) return;
    if (STATE.expandedScriptSectionId === secId) {
        STATE.expandedScriptSectionId = null;
    } else {
        STATE.expandedScriptSectionId = secId;
    }
    renderArtifactTabs();
}

function cancelScriptEdit(event) {
    event.stopPropagation();
    STATE.expandedScriptSectionId = null;
    renderArtifactTabs();
}

async function saveScriptEdit(secId, event) {
    event.stopPropagation();
    const dp = STATE.activeProject;
    if (!dp) return;
    
    const textVal = document.getElementById(`edit-script-text-${secId}`).value;
    const dirVal = document.getElementById(`edit-script-directions-${secId}`).value;
    
    const scriptArtifact = JSON.parse(JSON.stringify(dp.checkpoints.script.artifacts.script));
    const sec = scriptArtifact.sections.find(s => s.id === secId);
    if (sec) {
        sec.text = textVal;
        sec.speaker_directions = dirVal;
    }
    
    try {
        const res = await fetch(`/api/projects/${dp.project_id}/checkpoints/script`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ artifact: scriptArtifact })
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Failed to save script edits");
        }
        
        STATE.expandedScriptSectionId = null;
        await viewProjectDetails(dp.project_id);
    } catch (e) {
        alert("Error saving changes: " + e.message);
    }
}

function toggleSceneSection(scId, event) {
    if (event.target.closest('.edit-form')) return;
    if (STATE.expandedSceneId === scId) {
        STATE.expandedSceneId = null;
    } else {
        STATE.expandedSceneId = scId;
    }
    renderArtifactTabs();
}

function cancelSceneEdit(event) {
    event.stopPropagation();
    STATE.expandedSceneId = null;
    renderArtifactTabs();
}

async function saveSceneEdit(scId, event) {
    event.stopPropagation();
    const dp = STATE.activeProject;
    if (!dp) return;
    
    const descVal = document.getElementById(`edit-scene-desc-${scId}`).value;
    const typeVal = document.getElementById(`edit-scene-type-${scId}`).value;
    
    const scenePlanArtifact = JSON.parse(JSON.stringify(dp.checkpoints.scene_plan.artifacts.scene_plan));
    const scene = scenePlanArtifact.scenes.find(s => s.id === scId);
    if (scene) {
        scene.description = descVal;
        scene.type = typeVal;
    }
    
    try {
        const res = await fetch(`/api/projects/${dp.project_id}/checkpoints/scene_plan`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ artifact: scenePlanArtifact })
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Failed to save scene plan edits");
        }
        
        STATE.expandedSceneId = null;
        await viewProjectDetails(dp.project_id);
    } catch (e) {
        alert("Error saving changes: " + e.message);
    }
}
