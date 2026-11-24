"""Figures for the SlideX example deck (run: python3 make_figures.py)."""
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams.update({"font.family": "serif", "mathtext.fontset": "cm", "font.size": 11,
                     "axes.linewidth": 0.8, "xtick.direction": "in", "ytick.direction": "in",
                     "xtick.top": True, "ytick.right": True})

t = np.linspace(0, 6, 300)
fig, ax = plt.subplots(figsize=(4.2, 3.0))
for k, (s, c) in enumerate([(0.9, "#4477AA"), (0.6, "#66CCEE"), (0.3, "#228833")]):
    ax.semilogy(t, 0.01 * np.exp(s * t) * (1 + 0.04 * np.sin(5 * t + k)), color=c, lw=1.6, label=rf"$\sigma = {s}$")
ax.set_xlabel(r"time $t$")
ax.set_ylabel(r"amplitude $\zeta / \zeta_0$")
ax.legend(frameon=False, loc="upper left")
fig.tight_layout()
fig.savefig("growth.pdf")
print("wrote growth.pdf")
