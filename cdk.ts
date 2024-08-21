import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * StaticSiteConstructProps.
 */
interface StaticSiteConstructProps {
  account: string;
}

/**
 * StaticSiteConstruct.
 */
class StaticSiteConstruct extends Construct {
  constructor(scope: Construct, id: string, props: StaticSiteConstructProps) {
    super(scope, id);

    const domainName = "krzmknt.net";
    const subdomain = "tetris";
    const hostedZoneId = "Z07535921NYFY978ZI5LP";

    // Route 53 public hosted zone
    const hostedZone = route53.PublicHostedZone.fromHostedZoneAttributes(
      this,
      "Route53PublicHostedZone",
      {
        hostedZoneId,
        zoneName: domainName,
      }
    );

    // ACM
    const certificate = new acm.Certificate(this, "SiteCertificate", {
      domainName: `${subdomain}.${domainName}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // S3
    const destinationBucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // S3 にローカルのソースをデプロイ
    new s3deploy.BucketDeployment(this, "BucketsDeployment", {
      sources: [s3deploy.Source.asset("./src/")],
      destinationBucket,
    });

    // IP セット
    // 特定のグローバルIPアドレスからのアクセスを遮断する
    const ipSet = new wafv2.CfnIPSet(this, "IPSet", {
      addresses: [],
      ipAddressVersion: "IPV4",
      scope: "CLOUDFRONT",
    });

    // Web ACL
    // 特定のグローバルIPアドレスからのアクセスを許可する
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      rules: [
        {
          name: "BlockSpecificIPs",
          priority: 0,
          action: { block: {} },
          statement: {
            ipSetReferenceStatement: {
              arn: ipSet.attrArn,
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "BlockSpecificIPs",
          },
        },
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "WebAcl",
      },
    });

    // CloudFront ディストリビューションにWebACLを関連付ける
    // `aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths "/*"`
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new cloudfrontOrigins.S3Origin(destinationBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",

      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 403,
          responsePagePath: "/403.html",
          ttl: cdk.Duration.minutes(30),
        },
      ],

      webAclId: webAcl.attrArn,
      domainNames: [`${subdomain}.${domainName}`],
      certificate,
    });

    // Route 53 Aレコードの作成
    new route53.ARecord(this, "AliasRecord", {
      zone: hostedZone,
      recordName: subdomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution)
      ),
    });

    // OAC
    //
    // 2024.8.22 時点で L2 非対応のため、CfnOriginAccessControlを使用しています
    // L2 が対応していないかチェックしてください。
    const cfnOriginAccessControl = new cloudfront.CfnOriginAccessControl(
      this,
      "OriginAccessControl",
      {
        originAccessControlConfig: {
          name: "OriginAccessControlForSsgBucket",
          originAccessControlOriginType: "s3",
          signingBehavior: "always",
          signingProtocol: "sigv4",
          description: "S3 Access Control",
        },
      }
    );

    // Additional settings for origin 0
    const cfnDistribution = distribution.node
      .defaultChild as cloudfront.CfnDistribution;

    // Delete OAI
    cfnDistribution.addOverride(
      "Properties.DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity",
      ""
    );

    // OAC does not require CustomOriginConfig
    cfnDistribution.addPropertyDeletionOverride(
      "DistributionConfig.Origins.0.CustomOriginConfig"
    );

    // By default, the s3 WebsiteURL is set and an error occurs, so set the S3 domain name
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.DomainName",
      destinationBucket.bucketRegionalDomainName
    );

    // OAC settings
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.OriginAccessControlId",
      cfnOriginAccessControl.getAtt("Id")
    );

    // Bucket policy で OAC からのアクセスを許可する
    const bucketPolicyStatement = new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
      resources: [`${destinationBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          "AWS:SourceArn": `arn:aws:cloudfront::${props.account}:distribution/${distribution.distributionId}`,
        },
      },
    });
    destinationBucket.addToResourcePolicy(bucketPolicyStatement);
  }
}

/**
 * StaticSiteStack.
 */
class StaticSiteStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new StaticSiteConstruct(this, "StaticSiteConstruct", {
      account: this.account,
    });
  }
}

const app = new cdk.App();
new StaticSiteStack(app, "StaticSiteStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "us-east-1",
  },
});
