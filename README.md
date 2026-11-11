# CloudFlow: serverless image processing on AWS

My personal cloud project: a signed-in user uploads images, chooses a size and format, and gets resized
files back. API Gateway accepts the job, SQS holds it, a Lambda function resizes the images with Pillow,
DynamoDB records the job and S3 stores the results, with a dead-letter queue, CloudWatch alarms,
per-function least-privilege IAM and a cost guard. It is deployed on AWS in us-east-2 and open to
signed-in users, including 24-hour test accounts that anyone can create, within daily quotas.

**Live demo:** see the repository's GitHub Pages URL (Settings → Pages) or the link on the profile.

What this page shows:

- **Runs**: choose images and your browser resizes them (nothing is uploaded) while a **simulation** of
  the AWS steps (validation, queue, retry, status) narrates the job. The browser demo never talks to AWS.
- **Architecture**: the deployed architecture drawn from one data file that a test checks against the
  Terraform, why it is asynchronous, and three reliability scenarios run in the simulation.
- **Results**: three headline numbers from the real deployment, what I observed on the real services, the
  first deployment and the two problems I found and fixed, with links to the sanitized evidence files on this site.

What stays private: the source repository (Python, Terraform, tests, runbooks) is private and available on
request.

Architecture adapted from a CloudProjects.dev recipe ("Asynchronous API Patterns with SQS" by amazon);
every departure is documented in the private project plan. Built with Terraform and Python 3.12.
