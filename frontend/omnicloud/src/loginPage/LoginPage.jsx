
import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Activity,
  Check,
  Cloud,
  Code2,
  Container,
  GitBranch,
  Globe2,
  HardDrive,
  Layers,
  Menu,
  Network,
  Server,
  ShieldCheck,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import "./LoginPage.css";
import AuthModal from "./AuthModal";

const providers = [
  {
    name: "Amazon Web Services",
    short: "AWS",
    logo: "/aws%20logo.png",
    className: "aws",
    description:
      "Manage the building blocks of cloud infrastructure through a consistent platform experience.",
    services: ["EC2", "S3", "VPC", "RDS"],
    detail: "Compute, storage, databases and networking",
  },
  {
    name: "Microsoft Azure",
    short: "Azure",
    logo: "/azure%20logo.png",
    className: "azure",
    description:
      "Organize virtual machines, cloud networking and application infrastructure.",
    services: ["Virtual Machines", "Virtual Network", "Storage", "Azure SQL"],
    detail: "Virtual machines, storage and application services",
  },
  {
    name: "Google Cloud Platform",
    short: "GCP",
    logo: "/google%20cloud%20logo.png",
    className: "gcp",
    description:
      "Build a consistent workflow around Google Cloud resources and infrastructure.",
    services: ["Compute Engine", "VPC", "Cloud Storage", "GKE"],
    detail: "Compute, networking, storage and managed services",
  },
];

const capabilities = [
  {
    number: "01",
    icon: Layers,
    title: "Unified control plane",
    description:
      "A common interface for organizing infrastructure across multiple cloud providers.",
    visual: "control",
    tag: "Centralized management",
  },
  {
    number: "02",
    icon: Code2,
    title: "Infrastructure as Code",
    description:
      "Use Terraform configurations and reviewable plans as the foundation for repeatable provisioning.",
    visual: "terraform",
    tag: "Terraform workflows",
  },
  {
    number: "03",
    icon: Container,
    title: "Containers and workloads",
    description:
      "Plan deployment workflows for containerized applications alongside traditional infrastructure.",
    visual: "containers",
    tag: "Container-ready design",
  },
  {
    number: "04",
    icon: Server,
    title: "Virtual machine management",
    description:
      "Organize VM provisioning requirements, machine configurations and deployment status.",
    visual: "compute",
    tag: "Compute resources",
  },
  {
    number: "05",
    icon: ShieldCheck,
    title: "Security and access",
    description:
      "Design for least-privilege permissions, protected credentials and auditable actions.",
    visual: "security",
    tag: "Security-conscious",
  },
  {
    number: "06",
    icon: Activity,
    title: "Operations visibility",
    description:
      "Create a foundation for resource inventories, operation history and deployment status.",
    visual: "monitor",
    tag: "Operational visibility",
  },
];

const workflowSteps = [
  {
    number: "01",
    icon: Globe2,
    title: "Connect your cloud",
    description:
      "Choose a provider and configure the appropriate account or project access.",
    detail: "AWS · Azure · Google Cloud",
  },
  {
    number: "02",
    icon: Code2,
    title: "Define infrastructure",
    description:
      "Choose the resource type and configure the infrastructure requirements.",
    detail: "Terraform · Variables · Templates",
  },
  {
    number: "03",
    icon: GitBranch,
    title: "Plan and provision",
    description:
      "Review proposed infrastructure changes before an authorized deployment.",
    detail: "Plan · Review · Apply",
  },
  {
    number: "04",
    icon: Activity,
    title: "Observe operations",
    description:
      "Review resource state, deployment results and operational history.",
    detail: "Status · Inventory · Audit trail",
  },
];

function Brand() {
  return (
    <a className="omni-brand" href="#home" aria-label="OmniCloud home">
      <span className="omni-brand-icon"><Cloud size={25} /></span>
      <span className="omni-brand-name">Omni<span>Cloud</span></span>
    </a>
  );
}

function Header({ onSignIn, onRegister }) {
  const [menuOpen, setMenuOpen] = useState(false);

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <header className="omni-header">
      <Brand />

      <button
        type="button"
        className="omni-menu-button"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label="Toggle navigation"
        aria-expanded={menuOpen}
      >
        {menuOpen ? <X size={23} /> : <Menu size={23} />}
      </button>

      <nav className={`omni-nav ${menuOpen ? "open" : ""}`}>
        <a href="#platform" onClick={closeMenu}>Platform</a>
        <a href="#providers" onClick={closeMenu}>Cloud providers</a>
        <a href="#architecture" onClick={closeMenu}>Architecture</a>
        <a href="#workflow" onClick={closeMenu}>How it works</a>
        <button
          type="button"
          className="omni-signin-button"
          onClick={() => {
            closeMenu();
            onSignIn();
          }}
        >
          Sign in
        </button>
        <button
          type="button"
          className="omni-register-button"
          onClick={() => {
            closeMenu();
            onRegister();
          }}
        >
          Register
        </button>
      </nav>
    </header>
  );
}

function ProviderLogo({ provider, size = "large" }) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <div
      className={`omni-provider-logo ${provider.className} ${size}`}
      aria-label={provider.name}
    >
      {imageFailed ? (
        <span className="omni-logo-fallback">{provider.short}</span>
      ) : (
        <img
          src={provider.logo}
          alt={`${provider.name} logo`}
          onError={() => setImageFailed(true)}
        />
      )}
    </div>
  );
}

function Hero() {
  return (
    <section className="omni-hero" id="home">
      <div className="omni-hero-copy">
        <div className="omni-eyebrow">
          <span className="omni-live-dot" />
          MULTI-CLOUD INFRASTRUCTURE PLATFORM
        </div>

        <h1>One control plane.<br /><span>Every cloud.</span></h1>

        <p className="omni-hero-description">
          Simplify infrastructure provisioning and application deployment.
          Bring AWS, Microsoft Azure and Google Cloud into one consistent
          management experience.
        </p>

        <div className="omni-hero-buttons">
          <a href="#platform" className="omni-button omni-button-primary">
            Explore the platform <ArrowRight size={19} />
          </a>
          <a href="#providers" className="omni-button omni-button-secondary">
            Discover cloud providers
          </a>
        </div>

        <div className="omni-proof-list">
          <span><Check size={17} /> Infrastructure as Code</span>
          <span><Check size={17} /> Provider-neutral workflows</span>
          <span><Check size={17} /> VMs and containers</span>
        </div>

        <div className="omni-hero-highlights">
          <article>
            <span className="omni-highlight-icon"><Layers size={21} /></span>
            <div>
              <h3>One unified interface</h3>
              <p>Manage heterogeneous infrastructure from one place.</p>
            </div>
          </article>
          <article>
            <span className="omni-highlight-icon"><Workflow size={21} /></span>
            <div>
              <h3>Terraform-powered workflows</h3>
              <p>Define, plan and review infrastructure changes.</p>
            </div>
          </article>
          <article>
            <span className="omni-highlight-icon"><ShieldCheck size={21} /></span>
            <div>
              <h3>Security-conscious architecture</h3>
              <p>Build toward protected credentials and controlled access.</p>
            </div>
          </article>
        </div>
      </div>

      <div className="omni-hero-graphic">
        <div className="omni-orbit omni-orbit-one" />
        <div className="omni-orbit omni-orbit-two" />

        <div className="omni-dashboard-card">
          <div className="omni-dashboard-header">
            <span className="omni-dashboard-cloud"><Cloud size={27} /></span>
            <div className="omni-dashboard-title">
              <strong>OmniCloud</strong>
              <span>Unified control plane</span>
            </div>
            <span className="omni-preview-label"><i /> Platform overview</span>
          </div>

          <div className="omni-connection-line"><span /><span /><span /></div>

          <div className="omni-mini-providers">
            {providers.map((provider) => (
              <article key={provider.short} className="omni-mini-provider">
                <ProviderLogo provider={provider} size="mini" />
                <strong>{provider.short}</strong>
                <span>{provider.short === "AWS" ? "Compute & storage" :
                  provider.short === "Azure" ? "Cloud resources" :
                    "Compute & networking"}</span>
              </article>
            ))}
          </div>

          <div className="omni-dashboard-tools">
            <span><Workflow size={17} /> Terraform</span>
            <span><Layers size={17} /> Containers</span>
            <span><Server size={17} /> Virtual machines</span>
          </div>

          <div className="omni-dashboard-bottom">
            <div>
              <span className="omni-status-dot blue" />
              <p>Infrastructure</p>
              <strong>Multi-cloud</strong>
            </div>
            <div>
              <span className="omni-status-dot green" />
              <p>Deployment</p>
              <strong>IaC workflows</strong>
            </div>
          </div>
        </div>

        <div className="omni-float-card omni-float-top">
          <span className="omni-float-icon"><Network size={22} /></span>
          <div><strong>One interface</strong><span>Multiple providers</span></div>
        </div>

        <div className="omni-float-card omni-float-bottom">
          <span className="omni-float-icon green"><ShieldCheck size={22} /></span>
          <div><strong>Security-aware</strong><span>Least-privilege design</span></div>
        </div>

        <p className="omni-graphic-caption">
          One consistent workflow across cloud environments
        </p>
      </div>
    </section>
  );
}

function ProvidersSection() {
  return (
    <section className="omni-section omni-providers-section" id="providers">
      <div className="omni-section-heading">
        <div className="omni-eyebrow">DESIGNED FOR HETEROGENEOUS CLOUDS</div>
        <h2>Your clouds. <span>One platform.</span></h2>
        <p>
          Bring infrastructure from leading cloud providers into a consistent
          operational workflow while retaining provider-specific capabilities.
        </p>
      </div>

      <div className="omni-provider-grid">
        {providers.map((provider, index) => (
          <article
            className={`omni-provider-card ${provider.className}`}
            key={provider.short}
          >
            <div className="omni-provider-card-head">
              <ProviderLogo provider={provider} size="provider" />
              <div className="omni-provider-index">0{index + 1}</div>
            </div>

            <div className="omni-provider-card-copy">
              <span className="omni-card-kicker">{provider.short} CLOUD</span>
              <h3>{provider.name}</h3>
              <p>{provider.description}</p>
            </div>

            <div className="omni-provider-divider" />

            <h4>Example resource areas</h4>
            <div className="omni-service-list">
              {provider.services.map((service) => (
                <span key={service}><Check size={14} /> {service}</span>
              ))}
            </div>

            <div className="omni-provider-card-footer">
              <span className="omni-provider-status-dot" />
              {provider.detail}
            </div>
          </article>
        ))}
      </div>

      <div className="omni-provider-note">
        <span className="omni-note-icon"><Globe2 size={23} /></span>
        <div>
          <strong>One management experience, different cloud capabilities</strong>
          <p>
            Provider integrations will use their supported APIs and Terraform
            providers where appropriate. Availability depends on implementation
            and configured permissions.
          </p>
        </div>
      </div>
    </section>
  );
}

function CapabilityVisual({ type }) {
  if (type === "control") {
    return (
      <div className="omni-visual-control">
        <div className="omni-visual-central"><Cloud size={29} /><strong>OmniCloud</strong></div>
        <div className="omni-visual-connectors"><i /><i /><i /></div>
        <div className="omni-visual-three">
          <span><Cloud size={22} /> AWS</span>
          <span><Cloud size={22} /> Azure</span>
          <span><Cloud size={22} /> GCP</span>
        </div>
      </div>
    );
  }

  if (type === "terraform") {
    return (
      <div className="omni-code-visual">
        <div className="omni-code-top"><span /><span /><span /><small>main.tf</small></div>
        <div className="omni-code-lines">
          <span><i>01</i><b>resource</b> "cloud_instance"</span>
          <span><i>02</i>&nbsp;&nbsp;name = <em>"app-server"</em></span>
          <span><i>03</i>&nbsp;&nbsp;region = <em>"region-a"</em></span>
          <span><i>04</i>&nbsp;&nbsp;managed = <strong>true</strong></span>
          <span><i>05</i>{"}"}</span>
        </div>
        <div className="omni-code-footer"><Check size={15} /> Illustrative IaC configuration</div>
      </div>
    );
  }

  if (type === "containers") {
    return (
      <div className="omni-container-visual">
        <div className="omni-container-node"><Container size={29} /><strong>Application</strong><small>Container image</small></div>
        <ArrowDown className="omni-visual-arrow" size={24} />
        <div className="omni-container-cluster">
          <span><Server size={21} /><b>Node 01</b></span>
          <span><Server size={21} /><b>Node 02</b></span>
          <span><Server size={21} /><b>Node 03</b></span>
        </div>
      </div>
    );
  }

  if (type === "compute") {
    return (
      <div className="omni-vm-visual">
        <div className="omni-vm-main"><Server size={31} /><div><strong>Virtual machine</strong><span>Compute resource</span></div><i /></div>
        <div className="omni-vm-stats"><span><HardDrive size={19} /> Storage</span><span><Network size={19} /> Network</span></div>
        <div className="omni-vm-bar"><span /></div>
        <small>Example resource configuration</small>
      </div>
    );
  }

  if (type === "security") {
    return (
      <div className="omni-security-visual">
        <div className="omni-security-shield"><ShieldCheck size={57} /></div>
        <div className="omni-security-list">
          <span><Check size={16} /> Least-privilege access</span>
          <span><Check size={16} /> Protected credentials</span>
          <span><Check size={16} /> Auditable operations</span>
        </div>
      </div>
    );
  }

  return (
    <div className="omni-monitor-visual">
      <div className="omni-monitor-heading"><span>Resource overview</span><Activity size={19} /></div>
      <div className="omni-monitor-metrics">
        <div><small>Providers</small><strong>03</strong></div>
        <div><small>Resource types</small><strong>VMs + Apps</strong></div>
      </div>
      <div className="omni-monitor-chart">
        {[35, 55, 43, 73, 52, 88, 62, 78, 47, 68, 91, 60].map((height, i) => (
          <span key={i} style={{ "--bar-height": `${height}%` }} />
        ))}
      </div>
      <small>Illustrative monitoring panel — live data not connected</small>
    </div>
  );
}

function PlatformSection() {
  return (
    <section className="omni-section omni-platform-section" id="platform">
      <div className="omni-section-heading">
        <div className="omni-eyebrow">THE OMNICLOUD PLATFORM</div>
        <h2>Cloud complexity, <span>simplified.</span></h2>
        <p>
          Infrastructure building blocks, repeatable workflows and operational
          visibility designed for multi-cloud environments.
        </p>
      </div>

      <div className="omni-capability-grid">
        {capabilities.map((capability) => {
          const Icon = capability.icon;

          return (
            <article className="omni-capability-card" key={capability.number}>
              <div className="omni-capability-top">
                <span className="omni-capability-icon"><Icon size={24} /></span>
                <span className="omni-capability-number">{capability.number}</span>
              </div>

              <CapabilityVisual type={capability.visual} />

              <div className="omni-capability-copy">
                <span className="omni-capability-tag">{capability.tag}</span>
                <h3>{capability.title}</h3>
                <p>{capability.description}</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ArchitectureSection() {
  return (
    <section className="omni-section omni-architecture-section" id="architecture">
      <div className="omni-section-heading">
        <div className="omni-eyebrow">PLATFORM ARCHITECTURE</div>
        <h2>One control plane. <span>Clear layers.</span></h2>
        <p>
          A proposed architecture that separates the user experience,
          orchestration, infrastructure definitions and provider-specific APIs.
        </p>
      </div>

      <div className="omni-architecture">
        <div className="omni-architecture-layer omni-layer-user">
          <div className="omni-layer-icon"><Layers size={26} /></div>
          <div className="omni-layer-copy">
            <span>LAYER 01</span>
            <h3>OmniCloud web interface</h3>
            <p>Workspace · Resource selection · Configuration · Operation history</p>
          </div>
          <span className="omni-layer-badge">React + Vite</span>
        </div>

        <div className="omni-layer-connector"><span /><ArrowDown size={21} /><span /></div>

        <div className="omni-architecture-layer omni-layer-control">
          <div className="omni-layer-icon"><Workflow size={26} /></div>
          <div className="omni-layer-copy">
            <span>LAYER 02</span>
            <h3>Control plane and orchestration</h3>
            <p>Authentication · Policy checks · Job orchestration · Audit records</p>
          </div>
          <span className="omni-layer-badge">Backend API</span>
        </div>

        <div className="omni-layer-connector"><span /><ArrowDown size={21} /><span /></div>

        <div className="omni-architecture-layer omni-layer-iac">
          <div className="omni-layer-icon"><Code2 size={26} /></div>
          <div className="omni-layer-copy">
            <span>LAYER 03</span>
            <h3>Infrastructure execution layer</h3>
            <p>Terraform plans · State management · Execution results</p>
          </div>
          <span className="omni-layer-badge">Terraform</span>
        </div>

        <div className="omni-layer-connector"><span /><ArrowDown size={21} /><span /></div>

        <div className="omni-architecture-clouds">
          {providers.map((provider) => (
            <div className={`omni-architecture-cloud ${provider.className}`} key={provider.short}>
              <ProviderLogo provider={provider} size="architecture" />
              <strong>{provider.short}</strong>
              <span>Provider API</span>
            </div>
          ))}
        </div>
      </div>

      <div className="omni-architecture-footnote">
        <ShieldCheck size={20} />
        <p>
          Security boundary: credentials should be handled by the backend using
          scoped permissions, secret storage and audited execution—not exposed
          in browser code.
        </p>
      </div>
    </section>
  );
}

function WorkflowSection() {
  return (
    <section className="omni-section omni-workflow-section" id="workflow">
      <div className="omni-section-heading">
        <div className="omni-eyebrow">HOW IT WORKS</div>
        <h2>From configuration <span>to operations.</span></h2>
        <p>
          A clear, reviewable process for managing infrastructure from
          configuration through deployment and ongoing operations.
        </p>
      </div>

      <div className="omni-workflow-line" />

      <div className="omni-workflow-grid">
        {workflowSteps.map((step) => {
          const Icon = step.icon;

          return (
            <article className="omni-workflow-card" key={step.number}>
              <div className="omni-workflow-card-top">
                <span className="omni-workflow-icon"><Icon size={26} /></span>
                <span className="omni-step-number">{step.number}</span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
              <div className="omni-workflow-detail"><Check size={15} /> {step.detail}</div>
            </article>
          );
        })}
      </div>

      <div className="omni-workflow-bottom">
        <div className="omni-workflow-bottom-icon"><Zap size={27} /></div>
        <div>
          <h3>Built for repeatable operations</h3>
          <p>
            The goal is to make common infrastructure tasks easier to review,
            standardize and repeat without hiding differences between providers.
          </p>
        </div>
        <a href="#home" className="omni-button omni-button-secondary">
          Back to top <ArrowRight size={17} />
        </a>
      </div>
    </section>
  );
}

function Footer({ onSignIn }) {
  return (
    <footer className="omni-footer">
      <div className="omni-footer-main">
        <Brand />
        <p>One control plane. Every cloud.</p>
        <span>A multi-cloud infrastructure platform in development.</span>
      </div>

      <div className="omni-footer-column">
        <strong>Platform</strong>
        <a href="#platform">Capabilities</a>
        <a href="#architecture">Architecture</a>
        <a href="#workflow">Workflows</a>
      </div>

      <div className="omni-footer-column">
        <strong>Cloud providers</strong>
        <a href="#providers">AWS</a>
        <a href="#providers">Microsoft Azure</a>
        <a href="#providers">Google Cloud</a>
      </div>

      <div className="omni-footer-column">
        <strong>Workspace</strong>
        <button type="button" onClick={onSignIn}>Sign in</button>
        <span>Secure sign in and account registration</span>
      </div>

      <div className="omni-copyright">
        <span>© {new Date().getFullYear()} OmniCloud</span>
        <span>Designed for heterogeneous cloud infrastructure</span>
      </div>
    </footer>
  );
}

export default function LoginPage() {
  const [loginOpen, setLoginOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");

  function openAuth(mode) {
    setAuthMode(mode);
    setLoginOpen(true);
  }

  return (
    <div className="omni-site">
      <Header onSignIn={() => openAuth("login")} onRegister={() => openAuth("register")} />
      <main>
        <Hero />
        <ProvidersSection />
        <PlatformSection />
        <ArchitectureSection />
        <WorkflowSection />
      </main>
      <Footer onSignIn={() => openAuth("login")} />
      {loginOpen && <AuthModal initialMode={authMode} onClose={() => setLoginOpen(false)} />}
    </div>
  );
}
